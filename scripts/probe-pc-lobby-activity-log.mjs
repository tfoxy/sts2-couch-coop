#!/usr/bin/env node
//
// Live probe for the F1 host connectivity log: the native panel that tells the person at the TV what the
// couch-coop plumbing is doing, because every one of those events otherwise goes only to a stderr that
// `sts2 game launch` sends to /dev/null.
//
// What it proves, in order:
//   1. it is safe to drive the live game at all (advisory live-session lock)
//   2. RECORDED WHILE INVISIBLE: a viewer connects and leaves on the MAIN MENU, where no panel exists;
//      the lobby opened afterwards already carries their name          [the ring records, the PANEL gates]
//   3. the node contract on the START-RUN host lobby, and ZERO intersection with the game's own
//      ReleaseInfo version label — screenshotted with Regent selected, whose orange background is what
//      makes that label legible in the first place
//   4. the same contract on the LOAD-RUN host lobby, clear of its NinePatchRect
//   5. negative gates: singleplayer character select, main menu, and mid-run → no panel at all
//   6. the collapse toggle works, and the collapsed state SURVIVES a screen change
//   7. more events than fit: the newest line is the last row, and the log body is still LAID OUT at its
//      full size (the check that catches a log which publishes text but renders nothing)
//   8. no CouchCoopActivity* node — and no player NAME the log carries — ever reaches a mirror client
//   9. every claim above has a screenshot under .sts2/artifacts/pc-lobby-activity-log/
//
// Run standalone (a game must already be up):
//   node scripts/probe-pc-lobby-activity-log.mjs
// or through the scenario, which also deploys + restarts the game:
//   sts2 --json test run tests/scenarios/pc-lobby-activity-log.sts2.yaml

import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  SCREEN_START_RUN_LOBBY, SCREEN_LOAD_RUN_LOBBY,
  FIXTURE_HOST_LOBBY, FIXTURE_LOAD_RUN_HOST_LOBBY, FIXTURE_MAIN_MENU,
  DESIGN_WIDTH,
  ProbeError, assert, sleep, sts2,
  acquireLiveLock, releaseLiveLock,
  sceneTree, nodesNamed, findNodePath, nodeDetails,
  globalRect, isVisible, textOf,
  hoverAndClick,
  loadFixture, waitFor, selectedCharacterButtonId, screenshot
} from "./probe-lib-lobby-qr.mjs";
import { SPIRECTL_ROOT } from "./lib/repo-layout.mjs";

// Non-host lobby (the game's own singleplayer character select) and an in-run screen, for the negative
// gates. Both live in the sibling spirectl checkout like FIXTURE_MAIN_MENU.
const FIXTURE_SP_LOBBY = resolve(SPIRECTL_ROOT, "fixtures/basic-lobby.sts2.fixture.yaml");
const FIXTURE_IN_RUN = resolve(SPIRECTL_ROOT, "fixtures/basic-map.sts2.fixture.yaml");

/**
 * Node-name contract (src/CouchCoop.Mod/HostUi/CouchCoopActivityPanel.cs).
 *
 * The `CouchCoopActivity` prefix is chosen to be SPECIFIC: a bare "CouchCoop" also appears in the game's
 * own "Mods loaded: … CouchCoop" label, which is not a leak, so the mirror scan below would false-positive
 * on it forever.
 */
const NAMES = {
  panel: "CouchCoopActivityPanel",
  card: "CouchCoopActivityCard",
  header: "CouchCoopActivityHeader",
  title: "CouchCoopActivityTitleLabel",
  toggle: "CouchCoopActivityToggleLabel",
  body: "CouchCoopActivityBody",
  logText: "CouchCoopActivityLogText"
};

/** The game's own version label, which shows through on the lobby. The panel must not touch it. */
const RELEASE_INFO_NODE = "ReleaseInfo";

/** CouchCoopActivityLayout, in design space. Right-anchored, so x is derived from the design width. */
const PANEL_RECT = {
  x: DESIGN_WIDTH - 584,
  y: 96,
  width: 560,
  height: 440
};
const HEADER_HEIGHT = 44;

/**
 * Floor for the LAID-OUT size of the log body, in design units.
 *
 * The exact rect is the card (560x440) less the content padding on three sides and the header strip:
 * 536x384. Asserted as a floor rather than an equality because the failure this exists to catch is a
 * COLLAPSE (a full-rect anchor set without offsets measured the label while it was still 0x0 and left it
 * at 1x0), not a few units of padding drift.
 */
const MIN_LOG_SIZE = { width: 500, height: 370 };

const EXPANDED_TOGGLE_TEXT = "–";
const COLLAPSED_TOGGLE_TEXT = "+";
/** CouchCoopActivityRender.EmptySummary / HeaderSummary. */
const HEADER_PREFIX = "Couch Co-Op activity";

/** The name this probe joins with. Must be recognisable in the panel AND absent from the mirror stream. */
const PROBE_VIEWER = "ProbeAnn";

const artifactDir = new URL("../.sts2/artifacts/pc-lobby-activity-log/", import.meta.url);
const artifactDirPath = fileURLToPath(artifactDir);
const relArtifact = name => `.sts2/artifacts/pc-lobby-activity-log/${name}`;

const evidence = { steps: [] };
const screenshots = [];
/** Rect equality tolerance in design units — layout is integral, so this only absorbs float noise. */
const RECT_EPSILON = 0.5;

function record(step, detail) {
  evidence.steps.push({ step, ...detail });
}

async function shot(name, note) {
  const path = relArtifact(name);
  const taken = await screenshot(path);
  screenshots.push({ name, path: `${artifactDirPath}${name}`, note, appliedViewport: taken.appliedViewport });
  return taken;
}

// NOTE: `computedTransform.globalRect.size` is a Vector2 — its components are `x`/`y`, NOT
// `width`/`height`. Reading `.width` here silently yields undefined.
function assertRect(actual, expected, what) {
  assert(actual?.position && actual?.size, `${what}: no computed rect`);
  const pairs = [
    ["x", actual.position.x, expected.x],
    ["y", actual.position.y, expected.y],
    ["width", actual.size.x, expected.width],
    ["height", actual.size.y, expected.height]
  ];
  for (const [label, got, want] of pairs) {
    assert(
      Number.isFinite(got) && Math.abs(got - want) <= RECT_EPSILON,
      `${what}: expected ${label}=${want} in design space, got ${got}`
    );
  }
}

function rectsIntersect(a, b) {
  return !(
    a.position.x + a.size.x <= b.position.x ||
    b.position.x + b.size.x <= a.position.x ||
    a.position.y + a.size.y <= b.position.y ||
    b.position.y + b.size.y <= a.position.y
  );
}

/**
 * Loads a lobby fixture and only returns once the lobby has PROVEN STABLE.
 *
 * Same hazard the QR probe encodes: a freshly restarted game is still finishing its boot flow (logo /
 * FTUE / leaderboard) and that flow pushes the main menu a few seconds in, POPPING a lobby the fixture
 * loader just created. Everything downstream then fails with an opaque "node path not found".
 */
async function loadLobbyFixtureStable(fixturePath, expectedScreenId, { attempts = 4, settleMs = 3000 } = {}) {
  let lastSeen = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await loadFixture(fixturePath);
    await waitForPanel(expectedScreenId);
    await sleep(settleMs);

    const after = await sceneTree();
    const stillThere = after?.screen?.id === expectedScreenId && nodesNamed(after, NAMES.panel).length === 1;
    if (stillThere) {
      if (attempt > 1) {
        record("lobby-restabilised", { fixturePath, expectedScreenId, attempt });
      }
      return findNodePath(after, NAMES.panel);
    }

    lastSeen = after?.screen?.id;
    record("lobby-collapsed-after-load", {
      fixturePath, expectedScreenId, attempt, screenAfterSettle: lastSeen,
      note: "the freshly restarted game's boot flow popped the fixture lobby; reloading"
    });
    await sleep(2000);
  }
  throw new ProbeError(
    `${fixturePath} could not hold ${expectedScreenId} for ${settleMs}ms across ${attempts} attempts ` +
    `(last screen: ${lastSeen}). The game keeps returning to the main menu — let it finish booting first.`
  );
}

/** Waits for the controller's 0.25s scan tick to install the panel on the live lobby screen. */
async function waitForPanel(expectedScreenId) {
  const tree = await waitFor(
    () => sceneTree(),
    value => value?.screen?.id === expectedScreenId && nodesNamed(value, NAMES.panel).length === 1,
    { attempts: 40, intervalMs: 250, what: `the activity panel to appear on ${expectedScreenId}` }
  );
  return { panelPath: findNodePath(tree, NAMES.panel), tree };
}

/** The markup-stripped log text, published by CouchCoopActivityLogLabel.GetFormattedText(). */
async function readLogText(panelPath) {
  const node = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.body}/${NAMES.logText}`);
  const text = textOf(node);
  assert(typeof text === "string", "the log label published no text — has spirectl's GetFormattedText probe changed?");
  return text;
}

async function readHeaderSummary(panelPath) {
  const node = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.header}/${NAMES.title}`);
  const text = textOf(node);
  assert(typeof text === "string" && text.startsWith(HEADER_PREFIX), `header summary was ${JSON.stringify(text)}`);
  return text;
}

// =================================================================================================
// A throwaway browser client, used to MAKE events happen
// =================================================================================================

/**
 * Connects to the hosted browser server, joins as {@link PROBE_VIEWER}, then closes.
 *
 * On the main menu this produces a connect line and a disconnect line and nothing else — no seat is
 * spawned, so the game is not disturbed. That is exactly what leg 2 needs: two events with a name in
 * them, generated while there is no panel on screen to receive them.
 */
async function connectAndLeaveAsViewer({ origin = process.env.COUCHCOOP_GAME_ORIGIN ?? "ws://127.0.0.1:13337" } = {}) {
  assert(typeof WebSocket === "function", "global WebSocket is unavailable — Node >= 22 required");
  const url = `${origin.replace(/\/$/, "")}/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`;

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let sawSession = false;
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closing */ }
      reject(new ProbeError(`no session reply from ${url} within 10s — is the browser server up?`));
    }, 10000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", requestId: "probe:activity-log", name: PROBE_VIEWER }));
    });

    socket.addEventListener("message", event => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      if (!data.includes('"type":"session"')) return;
      sawSession = true;
      clearTimeout(timer);
      // Give the host a beat to finish the join side effects before we drop the socket.
      setTimeout(() => { try { socket.close(); } catch { /* already closing */ } }, 250);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new ProbeError(`could not reach ${url}`));
    });

    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve({ url, sawSession });
    });
  });
}

/**
 * Connects as a passive client and scans the stream for BOTH failure modes.
 *
 * This is the WS-0 safety assertion in its F1 shape, and it has two halves. The node half is the same as
 * the QR panel's: a mirror client drives the host with real injected input, so anything it can see it can
 * press. The NAME half is specific to this panel — it renders player-chosen display names, and those must
 * not reach every other player's phone. `spirectl_stream_skip` is what enforces both, and it is stamped
 * before AddChild so a keyframe cannot race it.
 */
async function scanMirrorForActivityNodes({ durationMs = 8000, origin = process.env.COUCHCOOP_GAME_ORIGIN ?? "ws://127.0.0.1:13337" } = {}) {
  const url = `${origin.replace(/\/$/, "")}/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`;
  assert(typeof WebSocket === "function", "global WebSocket is unavailable — Node >= 22 required");

  return await new Promise(resolve => {
    const socket = new WebSocket(url);
    const matches = new Set();
    let viewerNameHits = 0;
    let messages = 0;
    let bytes = 0;
    let sawFullKeyframe = false;
    let fullKeyframeBytes = 0;
    let settled = false;
    let socketError = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      resolve({
        url, messages, bytes, sawFullKeyframe, fullKeyframeBytes,
        matches: [...matches], viewerNameHits, socketError
      });
    };

    const timer = setTimeout(finish, durationMs);

    socket.addEventListener("message", event => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      messages += 1;
      bytes += Buffer.byteLength(data, "utf8");
      if (data.includes('"type":"scene-delta"')) {
        if (!sawFullKeyframe && data.includes('"full":true')) {
          sawFullKeyframe = true;
          fullKeyframeBytes = Buffer.byteLength(data, "utf8");
        }
        // 1-credit flow control: ack instantly so the host keeps sending.
        try { socket.send('{"type":"scene-ack"}'); } catch { /* racing close */ }
      }
      for (const match of data.matchAll(/CouchCoopActivity[A-Za-z0-9_]*/g)) {
        matches.add(match[0]);
      }
      if (data.includes(PROBE_VIEWER)) {
        viewerNameHits += 1;
      }
    });

    socket.addEventListener("error", event => {
      socketError = event?.message ?? "websocket error";
      finish();
    });
    socket.addEventListener("close", finish);
  });
}

// =================================================================================================
// Step 2 — events are RECORDED while the panel is invisible
// =================================================================================================
async function assertRecordedWhileInvisible() {
  await loadFixture(FIXTURE_MAIN_MENU);
  await sleep(1500);

  const menuTree = await sceneTree();
  assert(
    nodesNamed(menuTree, NAMES.panel).length === 0,
    "the activity panel must NOT exist on the main menu — recording is always on, the PANEL is gated"
  );
  await shot("01-main-menu-no-panel.png", "main menu: recording is live but no panel is installed");

  const viewer = await connectAndLeaveAsViewer();
  assert(viewer.sawSession, "the probe viewer never received a session reply");
  // The disconnect line is written in the receive loop's finally, after the socket closes.
  await sleep(1000);

  const panelPath = await loadLobbyFixtureStable(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY);
  const logText = await readLogText(panelPath);
  assert(
    logText.includes(PROBE_VIEWER),
    `the lobby's panel does not carry the events recorded on the main menu; log reads: ${JSON.stringify(logText.slice(-400))}`
  );

  const summary = await readHeaderSummary(panelPath);
  record("recorded-while-invisible", { viewerUrl: viewer.url, headerSummary: summary, logTail: logText.slice(-400) });
  await shot("02-lobby-shows-earlier-events.png", "host lobby: the panel already carries events recorded on the main menu");
  return { panelPath, logText, summary };
}

/**
 * Best-effort: put the lobby on Regent before a clearance screenshot.
 *
 * Not decoration. The panel's top edge was chosen to sit under the game's own ReleaseInfo version label,
 * and that label is only clearly LEGIBLE against Regent's orange background — on a darker character the
 * screenshot cannot show whether the two collide, so a human reviewing the artifact learns nothing.
 * Best-effort because it is evidence quality, not a claim: the rect clearance itself is asserted from
 * computed transforms either way. Re-selecting the ALREADY-selected character is refused with
 * `reasonCode: not_visible`, so an already-Regent lobby is a no-op rather than a failure.
 */
async function trySelectRegent() {
  try {
    const current = await selectedCharacterButtonId();
    const payload = await sts2(["state", "actions"]);
    const actions = payload?.actions ?? [];
    const regent = actions.find(action =>
      action?.kind === "select-character"
      && action?.enabled !== false
      && typeof action?.args?.characterId === "string"
      && /regent/i.test(action.args.characterId)
      && action.args.characterId !== current);
    if (!regent) {
      record("select-regent", { skipped: true, current, note: "Regent is already selected, or not on offer" });
      return { selected: current, changed: false };
    }

    const owner = regent.ownerPlayerId ?? regent.args?.playerId;
    assert(owner, "select-character has no owner player id");
    const selection = await sts2(["act", "select-character", "--player-id", owner, "--character", regent.args.characterId]);
    assert(selection?.accepted === true, "select-character (Regent) was not accepted");
    await sleep(600);
    record("select-regent", { selected: regent.args.characterId, changed: true, previous: current });
    return { selected: regent.args.characterId, changed: true };
  } catch (error) {
    // Evidence quality only — never fail the probe over it.
    record("select-regent", { skipped: true, error: `${error?.message}` });
    return { selected: null, changed: false };
  }
}

// =================================================================================================
// Step 3/4 — node contract + clearance of the game's own version label
// =================================================================================================
async function assertPanelContract(fixturePath, expectedScreenId, { shotName, note, selectRegent = false }) {
  const panelPath = await loadLobbyFixtureStable(fixturePath, expectedScreenId);
  if (selectRegent) {
    await trySelectRegent();
  }

  const tree = await sceneTree();

  for (const [key, name] of Object.entries(NAMES)) {
    assert(nodesNamed(tree, name).length === 1, `expected exactly one ${name} (${key}) on ${expectedScreenId}`);
  }

  const card = await nodeDetails(`${panelPath}/${NAMES.card}`);
  assert(isVisible(card), "the card is visible");
  assertRect(globalRect(card), PANEL_RECT, `${expectedScreenId}: activity card`);

  const header = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.header}`);
  assertRect(
    globalRect(header),
    { x: PANEL_RECT.x, y: PANEL_RECT.y, width: PANEL_RECT.width, height: HEADER_HEIGHT },
    `${expectedScreenId}: activity header`
  );

  const toggle = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.header}/${NAMES.toggle}`);
  assert(textOf(toggle) === EXPANDED_TOGGLE_TEXT, `the toggle reads "${EXPANDED_TOGGLE_TEXT}" while expanded`);

  // The clearance that drove the placement: the game's own version label, which shows through here.
  const releaseInfoPath = findNodePath(tree, RELEASE_INFO_NODE);
  let releaseInfoRect = null;
  if (releaseInfoPath) {
    const releaseInfo = await nodeDetails(releaseInfoPath);
    releaseInfoRect = globalRect(releaseInfo);
    if (releaseInfoRect) {
      assert(
        !rectsIntersect(globalRect(card), releaseInfoRect),
        `the activity panel overlaps the game's ReleaseInfo version label ` +
        `(panel ${JSON.stringify(globalRect(card))}, label ${JSON.stringify(releaseInfoRect)})`
      );
    }
  }

  record("panel-contract", {
    screen: expectedScreenId, panelPath,
    cardRect: globalRect(card), releaseInfoPath, releaseInfoRect,
    releaseInfoNote: releaseInfoPath
      ? "asserted clear"
      : "ReleaseInfo not present in this screen's tree — clearance is asserted only where it exists"
  });

  await shot(shotName, note);
  return panelPath;
}

// =================================================================================================
// Step 5 — negative gates
// =================================================================================================
async function assertAbsentOn(fixturePath, label, shotName) {
  await loadFixture(fixturePath);
  // Give the 0.25s scan several ticks to install it if it were going to.
  await sleep(2500);
  const tree = await sceneTree();
  const found = nodesNamed(tree, NAMES.panel).length;
  assert(found === 0, `the activity panel must not exist on ${label} (found ${found})`);
  record("negative-gate", { label, fixturePath, screen: tree?.screen?.id, panels: found });
  await shot(shotName, `${label}: no activity panel`);
}

// =================================================================================================
// Step 6 — the collapse toggle, and that it survives a screen change
// =================================================================================================
async function assertCollapseTogglePersists() {
  let panelPath = await loadLobbyFixtureStable(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY);

  const headerPath = `${panelPath}/${NAMES.card}/${NAMES.header}`;
  await hoverAndClick(headerPath);
  await sleep(500);

  let toggle = await nodeDetails(`${headerPath}/${NAMES.toggle}`);
  assert(textOf(toggle) === COLLAPSED_TOGGLE_TEXT, `after one click the toggle must read "${COLLAPSED_TOGGLE_TEXT}"`);
  let card = await nodeDetails(`${panelPath}/${NAMES.card}`);
  assertRect(
    globalRect(card),
    { x: PANEL_RECT.x, y: PANEL_RECT.y, width: PANEL_RECT.width, height: HEADER_HEIGHT },
    "collapsed activity card"
  );
  const body = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.body}`);
  assert(!isVisible(body), "the collapsed panel hides its body");
  await shot("06-collapsed.png", "the activity panel collapsed to its header");

  // The collapse lives on a PROCESS static, not on the node — the panel is QueueFree'd on every screen
  // change, so a flag held on it would be lost the moment the host backs out and comes back.
  await loadFixture(FIXTURE_MAIN_MENU);
  await sleep(1500);
  panelPath = await loadLobbyFixtureStable(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY);
  toggle = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.header}/${NAMES.toggle}`);
  assert(textOf(toggle) === COLLAPSED_TOGGLE_TEXT, "the collapse must SURVIVE leaving and re-entering the lobby");
  card = await nodeDetails(`${panelPath}/${NAMES.card}`);
  assertRect(
    globalRect(card),
    { x: PANEL_RECT.x, y: PANEL_RECT.y, width: PANEL_RECT.width, height: HEADER_HEIGHT },
    "collapsed activity card after a screen change"
  );
  record("collapse-persists", { headerPath, cardRect: globalRect(card) });
  await shot("07-collapsed-after-screen-change.png", "still collapsed after main menu → lobby");

  // Expand again so the remaining legs (and the next probe run) start from the default state.
  await hoverAndClick(`${panelPath}/${NAMES.card}/${NAMES.header}`);
  await sleep(500);
  toggle = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.header}/${NAMES.toggle}`);
  assert(textOf(toggle) === EXPANDED_TOGGLE_TEXT, "a second click expands it again");
  return panelPath;
}

// =================================================================================================
// Step 7 — more events than fit: the NEWEST is what a host sees
// =================================================================================================
async function assertScrollsToTheNewest(panelPath) {
  // Generate well past a panel's worth of rows. Each connect/leave writes two lines, and none of them
  // spawn a seat (no name is submitted to a lobby that would accept one on the main menu path), so this
  // is cheap and does not disturb the game.
  for (let i = 0; i < 14; i += 1) {
    await connectAndLeaveAsViewer();
  }
  await sleep(1200);

  const summary = await readHeaderSummary(panelPath);
  const count = Number.parseInt(summary.replace(/[^0-9]/g, ""), 10);
  assert(Number.isFinite(count) && count > 25, `expected >25 events in the header summary, read "${summary}"`);

  const logNode = await nodeDetails(`${panelPath}/${NAMES.card}/${NAMES.body}/${NAMES.logText}`);
  const text = textOf(logNode) ?? "";
  const lines = text.split("\n").filter(Boolean);
  assert(lines.length > 25, `expected >25 rendered rows, found ${lines.length}`);
  assert(
    lines[lines.length - 1].includes(PROBE_VIEWER),
    `the NEWEST row should be the last viewer event; it reads ${JSON.stringify(lines[lines.length - 1])}`
  );

  // The log body must still be LAID OUT to render those rows. This replaced a leg that asserted a
  // `VScrollBar` child of the log node, which was unsound twice over:
  //
  //  * RichTextLabel's scrollbar is an INTERNAL child. A `dev scene tree` dump walks GetChildren(), which
  //    never returns internal children, so that assertion could not tell a healthy log from a broken one.
  //  * Every other check in this function reads the log through GetFormattedText(), which the panel serves
  //    from a StringBuilder it maintains itself. That text is published whether or not a single pixel is
  //    drawn — which is exactly how a log body laid out at 1x0 passed this whole probe while the host's
  //    television showed an empty card.
  //
  // So assert the geometry the rows actually need: >25 events are in the label (above) AND the label is
  // big enough to draw them (here).
  const logRect = globalRect(logNode);
  record("scrolls-to-newest", {
    headerSummary: summary, renderedRows: lines.length,
    newestRow: lines[lines.length - 1],
    logRect, logRectFloor: MIN_LOG_SIZE
  });
  assert(logRect?.position && logRect?.size, "the log body published no computed rect");
  assert(
    logRect.size.x >= MIN_LOG_SIZE.width && logRect.size.y >= MIN_LOG_SIZE.height,
    `the log body is not laid out large enough to render a single row: expected at least ` +
    `${MIN_LOG_SIZE.width}x${MIN_LOG_SIZE.height} design units, got ${logRect.size.x}x${logRect.size.y}. ` +
    `A full-rect ANCHOR preset applied without offsets collapses it to ~1x0, and every other assertion ` +
    `in this probe still passes while the panel renders nothing.`
  );

  await shot("08-scrolled-to-newest.png", "a log past the panel's height, showing its newest line");
}

// =================================================================================================
// Step 8 — nothing from the CouchCoopActivity* family, and no player NAME, reaches a mirror client
// =================================================================================================
async function assertMirrorExclusion(panelPath) {
  const tree = await sceneTree();
  const inGameTree = (tree.nodes ?? []).filter(node => node.name.startsWith("CouchCoopActivity")).map(node => node.name);
  assert(inGameTree.length >= 5, `the panel subtree should be visible to dev inspection, found ${inGameTree.length}`);

  const scan = await scanMirrorForActivityNodes({ durationMs: 8000 });
  assert(!scan.socketError, `mirror scan could not connect: ${scan.socketError}`);
  assert(scan.messages > 0, "mirror scan received no messages — is the browser server up?");
  assert(scan.sawFullKeyframe, 'mirror scan never saw a full keyframe ("full":true) to scan');
  assert(
    scan.matches.length === 0,
    `CouchCoopActivity* nodes leaked to a mirror client: ${scan.matches.join(", ")}.`
  );
  assert(
    scan.viewerNameHits === 0,
    `the name "${PROBE_VIEWER}" reached a mirror client ${scan.viewerNameHits} time(s). This panel renders ` +
    "player-chosen display names, so the stream-skip stamp is what keeps one player's name off every other " +
    "player's phone."
  );

  record("mirror-exclusion", {
    url: scan.url, messages: scan.messages, bytes: scan.bytes,
    fullKeyframeBytes: scan.fullKeyframeBytes,
    couchCoopActivityNamesInGameTree: inGameTree.length,
    couchCoopActivityNamesOnMirror: scan.matches.length,
    probeViewerNameHitsOnMirror: scan.viewerNameHits,
    positiveControl:
      "To prove this scan is sensitive rather than blind, relaunch with " +
      "SPIRECTL_SCENE_WATCH_HONOR_STREAM_SKIP=0 and re-run: every CouchCoopActivity* name (and the log's " +
      "text, names included) then appears on this same stream.",
    panelPath
  });
}

// =================================================================================================
// main
// =================================================================================================
let lock = null;
try {
  await mkdir(artifactDir, { recursive: true });
  // A failure.json left by an earlier run would otherwise be mistaken for this run's outcome.
  await rm(new URL("failure.json", artifactDir), { force: true });
  lock = await acquireLiveLock("pc-lobby-activity-probe");
  record("live-lock", lock);

  const recorded = await assertRecordedWhileInvisible();
  await assertPanelContract(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY, {
    shotName: "03-start-run-lobby-regent.png",
    note: "start-run host lobby with Regent selected (its orange background is what makes the game's own "
      + "version label legible): panel at its contract rect, clear of that label",
    selectRegent: true
  });
  await assertPanelContract(FIXTURE_LOAD_RUN_HOST_LOBBY, SCREEN_LOAD_RUN_LOBBY, {
    shotName: "04-load-run-lobby.png",
    note: "load-run host lobby: same rect, clear of the load screen's NinePatchRect"
  });

  await assertAbsentOn(FIXTURE_SP_LOBBY, "the singleplayer character select", "05a-sp-lobby-absent.png");
  await assertAbsentOn(FIXTURE_MAIN_MENU, "the main menu", "05b-main-menu-absent.png");
  await assertAbsentOn(FIXTURE_IN_RUN, "a run in progress", "05c-in-run-absent.png");

  const panelPath = await assertCollapseTogglePersists();
  await assertScrollsToTheNewest(panelPath);
  await assertMirrorExclusion(panelPath);

  const result = {
    ok: true,
    headerSummary: recorded.summary,
    assertions: {
      liveLock: "ok",
      recordedWhileInvisible: "ok",
      nodeContractStartRunLobby: "ok",
      nodeContractLoadRunLobby: "ok",
      releaseInfoClearance: "ok",
      negativeGateSingleplayerLobby: "ok",
      negativeGateMainMenu: "ok",
      negativeGateInRun: "ok",
      collapseTogglePersistsAcrossScreens: "ok",
      scrollsToTheNewestRow: "ok",
      logBodyLaidOutForRendering: "ok",
      mirrorExcludesNodesAndNames: "ok"
    },
    screenshots: screenshots.map(entry => entry.path)
  };

  const artifactPath = new URL("result.json", artifactDir);
  await writeFile(artifactPath, `${JSON.stringify({ result, screenshots, evidence }, null, 2)}\n`);
  console.log(JSON.stringify({
    output: result,
    artifacts: [
      { path: fileURLToPath(artifactPath), kind: "json" },
      ...screenshots.map(entry => ({ path: entry.path, kind: "screenshot" }))
    ]
  }));
} catch (error) {
  const failure = {
    ok: false,
    message: error instanceof ProbeError ? error.message : `${error?.name}: ${error?.message}`,
    stack: error instanceof ProbeError ? undefined : error?.stack,
    screenshots: screenshots.map(entry => entry.path),
    evidence
  };
  try {
    await writeFile(new URL("failure.json", artifactDir), `${JSON.stringify(failure, null, 2)}\n`);
  } catch { /* artifact dir may not exist yet */ }
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await releaseLiveLock(lock);
}
