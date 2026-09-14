#!/usr/bin/env node
//
// Live probe for the WS-2 lobby QR host panel: the game-styled "Couch Co-Op QR Code" button and
// the host-select dialog it opens, which together REPLACED the always-on QR overlay.
//
// What it proves, in order:
//   1. it is safe to drive the live game at all (advisory live-session lock)
//   2. the button is absent on a non-host screen              [negative gate]
//   3. the button sits at the contract rect 226,732 352x136 on the START-RUN host lobby
//   4. hovering + clicking it opens the dialog                [NClickableControl is focus-gated]
//   5. the default option is a plain interface IPv4 (never a link, never .local), and the
//      expanded list is the adapter x method cross product with the mDNS name LAST
//   6. picking a different option re-renders BOTH the URL label and the QR pixels
//      (proved with an ROI screenshot-diff over the QR's own rect, not by trusting a property);
//      hovering a row shows its hover-tip pair, whose TEXT never reaches a mirror client
//   7. while the dialog is open, a real click on a lobby control changes nothing;
//      the same click works once the dialog is closed         [asserted on the INPUT path]
//   8. the dialog closes by its Close button AND by an outside click
//   9. the SAME button sits at the SAME rect on the LOAD-RUN host lobby
//  10. no CouchCoopQr* node ever reaches a passive client
//  11. every claim above has a screenshot under .sts2/artifacts/pc-lobby-qr-overlay/
//
// Run standalone (a game must already be up):
//   node scripts/probe-pc-lobby-qr-overlay.mjs
// or through the scenario, which also deploys + restarts the game:
//   sts2 --json test run tests/scenarios/pc-lobby-qr-overlay.sts2.yaml

import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NAMES, BUTTON_RECT, BUTTON_TEXT, CLOSE_BUTTON_TEXT, DIALOG_TITLE_TEXT,
  SCREEN_START_RUN_LOBBY, SCREEN_LOAD_RUN_LOBBY,
  FIXTURE_HOST_LOBBY, FIXTURE_LOAD_RUN_HOST_LOBBY, FIXTURE_MAIN_MENU,
  ProbeError, assert, sleep,
  acquireLiveLock, releaseLiveLock,
  sceneTree, sceneTreeWithProperties, nodesNamed, findNodePath, nodeDetails,
  globalRect, isVisible, textOf, rowLabelText,
  hoverAndClick, hoverNode, clickAt, bareScrimPoint, holdViewer,
  loadFixture, waitFor, selectedCharacterButtonId, lobbyNetGameType,
  screenshot, designRectToPixels, roiDiffRatio, scanMirrorForQrNodes
} from "./probe-lib-lobby-qr.mjs";

const artifactDir = new URL("../.sts2/artifacts/pc-lobby-qr-overlay/", import.meta.url);
const artifactDirPath = fileURLToPath(artifactDir);
const relArtifact = name => `.sts2/artifacts/pc-lobby-qr-overlay/${name}`;

const evidence = { steps: [] };
const screenshots = [];
/** Rect equality tolerance in design units -- layout is integral, so this only absorbs float noise. */
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

// NOTE: `computedTransform.globalRect.size` is a Vector2 -- its components are `x`/`y`, NOT
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

/**
 * Loads a lobby fixture and only returns once the lobby has PROVEN STABLE.
 *
 * A freshly restarted game is still finishing its own boot flow (logo / FTUE / leaderboard), and that
 * flow pushes the main menu onto the submenu stack a few seconds in -- popping a lobby the fixture
 * loader had just created. Observed directly: fixture lobby at 11:23:02, back on the main menu at
 * 11:23:04. Everything downstream then fails with an opaque "node path not found", because the whole
 * screen (and with it the injected panel) is gone.
 *
 * So: load, wait for the panel, then confirm it is STILL there after a settle window, and reload the
 * fixture if the boot flow stole the screen.
 */
async function loadLobbyFixtureStable(fixturePath, expectedScreenId, { attempts = 4, settleMs = 3000 } = {}) {
  let lastSeen = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await loadFixture(fixturePath);
    const { panelPath } = await waitForPanel(expectedScreenId);
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
    `(last screen: ${lastSeen}). The game keeps returning to the main menu -- let it finish booting first.`
  );
}

/** Resolves the injected panel on whichever lobby screen is live, waiting for the 0.25s scan tick. */
async function waitForPanel(expectedScreenId) {
  const tree = await waitFor(
    () => sceneTree(),
    value => value?.screen?.id === expectedScreenId && nodesNamed(value, NAMES.panel).length > 0,
    { attempts: 40, intervalMs: 250, what: `${NAMES.panel} on ${expectedScreenId}` }
  );
  const panelPath = findNodePath(tree, NAMES.panel);
  const panels = nodesNamed(tree, NAMES.panel);
  assert(panels.length === 1, `expected exactly one ${NAMES.panel}, found ${panels.length}`);
  return { tree, panelPath };
}

const at = (panelPath, suffix) => (suffix ? `${panelPath}/${suffix}` : panelPath);
const DIALOG = NAMES.dialog;
const DIALOG_PANEL = `${NAMES.dialog}/${NAMES.dialogPanel}`;

async function dialogVisible(panelPath) {
  const node = await nodeDetails(at(panelPath, DIALOG), { transform: false });
  return isVisible(node);
}

/**
 * What a mirror scan saw, for an assertion message. A bare "never saw a full keyframe" is the least
 * actionable failure this probe can produce -- it reads as a broken product and is usually a scan
 * pointed at the wrong host, so the url and the traffic counters go in the message itself.
 */
function describeScan(scan) {
  return `url=${scan.url} messages=${scan.messages} bytes=${scan.bytes}` +
    `${scan.socketError ? ` socketError=${scan.socketError}` : ""}`;
}

/**
 * Which mirror the stream scans belong to.
 *
 * 13337 is only the host's FIRST choice of port; it walks when that is taken, which it is whenever a
 * second instance is running. The scan helper's hard-coded default therefore connects to whatever game
 * owns 13337 — a real one, so the socket opens and no error is reported, and the leg fails minutes
 * later with "never saw a full keyframe" while the host under test was streaming perfectly on another
 * port. The dialog displays this host's own base URL, so the port is taken from there as soon as it is
 * read. An explicit COUCHCOOP_GAME_ORIGIN still wins: scanning from another machine is a real use.
 */
let mirrorOrigin = process.env.COUCHCOOP_GAME_ORIGIN ?? null;
function learnMirrorOrigin(displayedUrl) {
  if (process.env.COUCHCOOP_GAME_ORIGIN || !displayedUrl) return;
  try {
    const port = new URL(displayedUrl).port;
    if (port) mirrorOrigin = `ws://127.0.0.1:${port}`;
  } catch {
    // Not a URL we can parse — leave the helper on its own default rather than guessing.
  }
}
const mirrorScanOptions = () => (mirrorOrigin ? { origin: mirrorOrigin } : {});

/**
 * The controller re-scans every 0.25s and will QueueFree + re-add the panel whenever its gate
 * momentarily reads false (which happens in practice shortly after a game restart, when the state
 * capability is still settling). A re-add produces a NEW panel node -- and therefore a NEW, CLOSED
 * dialog -- so a node path captured earlier goes stale and every subsequent query fails with an
 * opaque `invalid_query_filter`.
 *
 * Rather than paper over that, each dialog interaction re-resolves the panel first and any reinstall
 * is RECORDED, so the behaviour stays visible in the evidence instead of turning into a flaky probe.
 */
let panelReinstalls = 0;
async function resolvePanelPath(expectedScreenId) {
  const { panelPath } = await waitForPanel(expectedScreenId);
  return panelPath;
}

/** Re-resolves the panel and guarantees the dialog is open, reopening it if a reinstall closed it. */
async function ensureDialogOpen(panelPath, expectedScreenId, why) {
  const fresh = await resolvePanelPath(expectedScreenId);
  if (fresh !== panelPath) {
    panelReinstalls += 1;
    record("panel-reinstalled", { why, previousPath: panelPath, newPath: fresh });
  }
  if (!(await dialogVisible(fresh))) {
    if (fresh === panelPath) {
      panelReinstalls += 1;
      record("dialog-closed-unexpectedly", { why, panelPath: fresh });
    }
    await hoverAndClick(at(fresh, NAMES.button));
    await sleep(700);
    assert(await dialogVisible(fresh), `${why}: could not (re)open the dialog`);
  }
  return fresh;
}

// =================================================================================================
// Step 2 -- negative gate: a non-host screen must carry NO panel
// =================================================================================================
async function assertNegativeGate() {
  await loadFixture(FIXTURE_MAIN_MENU);
  // The main menu reports two different screen ids depending on how it was reached: the fixture
  // recipe id `main-menu` when the loader materialized it, and the game-derived
  // `Screens.MainMenu.NMainMenu` when the process simply booted there. Either is a valid non-host
  // screen -- what this leg actually asserts is the ABSENCE of the panel, not the id.
  const isMainMenu = id => typeof id === "string" && /main-?menu/i.test(id);
  const tree = await waitFor(
    () => sceneTree(),
    value => isMainMenu(value?.screen?.id),
    { what: "a main-menu screen (main-menu or Screens.MainMenu.NMainMenu)" }
  );
  const found = nodesNamed(tree, NAMES.panel);
  const anyQr = (tree.nodes ?? []).filter(node => node.name.startsWith("CouchCoopQr"));
  assert(found.length === 0, `${NAMES.panel} must not exist on the main menu, found ${found.length}`);
  assert(anyQr.length === 0, `no CouchCoopQr* node may exist off a host lobby, found ${anyQr.map(n => n.name).join(", ")}`);

  await shot("08-negative-gate-non-host-screen.png", "main menu: the QR button is absent because the gate requires a host lobby");
  record("negative-gate", {
    screen: tree.screen?.id,
    couchCoopQrNodes: anyQr.length,
    note:
      "The singleplayer-lobby branch of CouchCoopLobbyHostGate is covered by the unit suite " +
      "(tests/CouchCoop.Mod.Tests/CouchCoopLobbyHostGateTests.cs asserts netGameType 'singleplayer' and " +
      "'client' are both refused). It is NOT reachable live: every characterSelect fixture recipe starts a " +
      "real ENet host, so the fixture loader cannot produce a singleplayer lobby at all."
  });
}

// =================================================================================================
// Steps 3-8 -- the start-run host lobby: rect, open, options, QR change, blocking, close
// =================================================================================================
async function assertStartRunLobby() {
  let panelPath = await loadLobbyFixtureStable(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY);

  const netGameType = await lobbyNetGameType();
  assert(netGameType === "host", `fixture must produce a HOST lobby, got netGameType=${netGameType}`);

  // --- 3. button rect -------------------------------------------------------------------------
  const button = await nodeDetails(at(panelPath, NAMES.button));
  assertRect(globalRect(button), BUTTON_RECT, "start-run lobby QR button");
  assert(isVisible(button), "the QR button must be visible on a host lobby");

  const buttonTree = await sceneTreeWithProperties(at(panelPath, NAMES.button));
  const label = (buttonTree.nodes ?? []).map(textOf).find(Boolean);
  assert(label === BUTTON_TEXT, `button label must read ${JSON.stringify(BUTTON_TEXT)}, got ${JSON.stringify(label)}`);

  await shot("01-host-lobby-button.png", `start-run host lobby: button at ${BUTTON_RECT.x},${BUTTON_RECT.y} ${BUTTON_RECT.width}x${BUTTON_RECT.height}`);
  record("button-rect-start-run", { screen: SCREEN_START_RUN_LOBBY, rect: globalRect(button), label, netGameType });

  // --- 4. open the dialog ---------------------------------------------------------------------
  assert(!(await dialogVisible(panelPath)), "the dialog must start hidden");
  const openClick = await hoverAndClick(at(panelPath, NAMES.button));
  await sleep(600);
  assert(await dialogVisible(panelPath), "clicking the QR button must open the dialog");

  const dialogTree = await sceneTreeWithProperties(at(panelPath, DIALOG));
  const title = (dialogTree.nodes ?? []).find(n => n.name === NAMES.title);
  assert(textOf(title) === DIALOG_TITLE_TEXT, `dialog title must read ${JSON.stringify(DIALOG_TITLE_TEXT)}`);
  const closeLabel = rowLabelText(dialogTree, NAMES.closeButton);
  assert(closeLabel === CLOSE_BUTTON_TEXT, `close button must read ${JSON.stringify(CLOSE_BUTTON_TEXT)}, got ${JSON.stringify(closeLabel)}`);

  // Steam-offline notice: hidden unless the host fell back to ENet.
  const notice = (dialogTree.nodes ?? []).find(n => n.name === NAMES.noticeLabel);
  record("dialog-open", { openClick, title: textOf(title), closeLabel, noticeVisible: notice?.properties?.visible === true });

  // --- 5. default option is a plain interface IPv4 ----------------------------------------------
  // The single-select redesign: the default is the best adapter's PLAIN address (the only method that
  // needs no internet), never a link row and never the .local name — mDNS is the least reliable
  // method and is pinned to the LAST row instead.
  const defaultUrl = textOf((dialogTree.nodes ?? []).find(n => n.name === NAMES.urlLabel));
  const defaultOption = rowLabelText(dialogTree, NAMES.hostSelectCurrent);
  assert(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(defaultOption ?? ""), `default option must be a plain interface IPv4 with a port, got ${JSON.stringify(defaultOption)}`);
  assert(defaultUrl === `http://${defaultOption}/`, `default URL must be the plain address URL, got ${JSON.stringify(defaultUrl)}`);
  // The host names its own port here; every later mirror scan uses it. See learnMirrorOrigin.
  learnMirrorOrigin(defaultUrl);

  const qrNode = await nodeDetails(at(panelPath, `${DIALOG_PANEL}/${NAMES.qrTexture}`));
  assert(isVisible(qrNode), "the QR texture must be visible once an address is selected");
  const qrRect = globalRect(qrNode);
  assert(qrRect?.size?.x >= 200, `the QR must be large enough to scan across a room, got ${qrRect?.size?.x}`);

  await shot("02-dialog-open-default-ipv4.png", `dialog open, default option ${defaultOption}`);
  record("default-option", { defaultOption, defaultUrl, qrRect });

  // --- QR sizing contract (ASSERTED) ------------------------------------------------------------
  // `HostLobbyQrOverlayLayout.QrDisplayExtent` is a CONSTANT: every payload renders at exactly
  // `qrDialogExtent` design units, whatever module count it encodes. The whole-number rule that keeps
  // module edges hard (a fractional scale merges/splits modules and can make the code unscannable at the
  // exact moment someone points a phone at it) lives in the RASTER now -- `QrRasterPlan` gives every
  // module an identical whole number of source pixels and pads the leftover with white quiet zone.
  //
  // The check works without knowing the module count, because LayoutBody derives three independent
  // things from the same `extent`: the QR's Position (centred: (PanelWidth - extent) / 2), the URL
  // label's top (QrTop + extent + UrlGap), and the QR's Size. If Size disagrees with the other two, the
  // box was clamped after the fact -- which is exactly the regression this guards
  // (`CustomMinimumSize` must be assigned BEFORE `Size`, see CouchCoopQrDialog.LayoutBody).
  const urlNode = await nodeDetails(at(panelPath, `${DIALOG_PANEL}/${NAMES.urlLabel}`));
  const urlRect = globalRect(urlNode);
  const PANEL_WIDTH = 1000, QR_TOP = 152, URL_GAP = 6;
  const QR_DISPLAY_EXTENT = 592; // HostLobbyQrOverlayLayout.Default.QrDialogExtent -- the exact size, not a budget
  const dialogPanelRect = globalRect(await nodeDetails(at(panelPath, DIALOG_PANEL), { properties: false }));
  const extentFromPosition = PANEL_WIDTH - 2 * (qrRect.position.x - dialogPanelRect.position.x);
  const extentFromUrlTop = (urlRect.position.y - dialogPanelRect.position.y) - QR_TOP - URL_GAP;
  const reportedExtent = qrRect.size.x;
  const qrBottom = qrRect.position.y + qrRect.size.y;

  const clampDiagnosis =
    "The rendered QR box disagrees with the extent LayoutContent computed. That is the "
    + "`CustomMinimumSize` clamp regression: Godot clamps Size against the CURRENT minimum, so assigning "
    + "Size while the previous pass's larger minimum is still set keeps the stale extent, and "
    + "`CustomMinimumSize = _qr.Size` then latches it. Assign the minimum FIRST.";

  assert(qrRect.size.x === qrRect.size.y, `the QR box must be square, got ${qrRect.size.x}x${qrRect.size.y}`);
  assert(
    reportedExtent === extentFromPosition,
    `QR box ${reportedExtent} != the ${extentFromPosition} its own centred Position implies. ${clampDiagnosis}`
  );
  assert(
    reportedExtent === extentFromUrlTop,
    `QR box ${reportedExtent} != the ${extentFromUrlTop} the URL label's top implies. ${clampDiagnosis}`
  );
  // The load-bearing one: the box is the SAME for every payload. Picking a secure or web row swaps a
  // 37-module code for a denser one, and the whole point of the constant extent is that the player
  // cannot see that happen.
  assert(
    reportedExtent === QR_DISPLAY_EXTENT,
    `QR extent ${reportedExtent} is not the constant ${QR_DISPLAY_EXTENT}: the box is tracking the payload again`
  );
  // The URL is the typeable fallback; drawn over the QR's white quiet zone it is unreadable.
  assert(
    urlRect.position.y >= qrBottom,
    `the URL label (top ${urlRect.position.y}) must sit BELOW the QR box (bottom ${qrBottom}); it currently ` +
    `overlaps the quiet zone by ${qrBottom - urlRect.position.y}px`
  );

  record("qr-sizing-contract", {
    status: "ok",
    extentImpliedByQrPosition: extentFromPosition,
    extentImpliedByUrlTop: extentFromUrlTop,
    extentReportedBySize: reportedExtent,
    qrBottom,
    urlTop: urlRect.position.y,
    gapBelowQr: urlRect.position.y - qrBottom,
    constantExtent: QR_DISPLAY_EXTENT
  });

  // --- 6. list shape (methods per adapter, mdns last), hover tips, switch -> URL + QR change ----
  const qrBefore = await shot("03a-qr-before-switch.png", "QR for the plain-address default, baseline for the ROI diff");

  // Re-resolve first: shortly after a game restart the controller has been observed tearing the panel
  // down and re-adding it between steps, which silently invalidates every captured node path.
  panelPath = await ensureDialogOpen(panelPath, SCREEN_START_RUN_LOBBY, "host-select interaction");

  await hoverAndClick(at(panelPath, `${DIALOG_PANEL}/${NAMES.hostSelect}/${NAMES.hostSelectCurrent}`));
  await sleep(500);
  const listNode = await nodeDetails(at(panelPath, `${DIALOG_PANEL}/${NAMES.hostSelect}/${NAMES.hostSelectList}`), { transform: false });
  assert(isVisible(listNode), "clicking the current row must expand the option list");
  await shot("03-host-select-open.png", "option list expanded: adapter x method rows, mdns last");

  const openListTree = await sceneTreeWithProperties(at(panelPath, `${DIALOG_PANEL}/${NAMES.hostSelect}`));
  const optionNames = (openListTree.nodes ?? [])
    .filter(node => node.name.startsWith(NAMES.optionPrefix) && /^\d+$/.test(node.name.slice(NAMES.optionPrefix.length)))
    .map(node => node.name)
    .sort((a, b) => Number(a.slice(NAMES.optionPrefix.length)) - Number(b.slice(NAMES.optionPrefix.length)));
  assert(optionNames.length >= 4, `an adapter triple plus the mdns row is the minimum list, found ${optionNames.length}`);

  const labelOf = name => rowLabelText(openListTree, name);
  // Cross-product shape: option0 is the default's plain address, option1 the same adapter's web
  // link (the public origin's host), and the LAST row is the .local name — always, that is the rule.
  assert(labelOf(`${NAMES.optionPrefix}0`) === defaultOption,
    `option 0 should be the default plain address, got ${JSON.stringify(labelOf(`${NAMES.optionPrefix}0`))}`);
  const webLabel = labelOf(`${NAMES.optionPrefix}1`);
  assert(/pages\.dev|^[a-z0-9.-]+$/i.test(webLabel ?? "") && !/^\d+\.\d+\.\d+\.\d+:/.test(webLabel ?? ""),
    `option 1 should be the web-link row (a domain, not an ip:port), got ${JSON.stringify(webLabel)}`);
  const lastOption = optionNames[optionNames.length - 1];
  const mdnsLabel = labelOf(lastOption);
  assert(/\.local:\d+$/.test(mdnsLabel ?? ""), `the LAST option must be the .local name, got ${JSON.stringify(mdnsLabel)}`);
  record("list-shape", { optionNames, labels: optionNames.map(labelOf), mdnsLast: mdnsLabel });

  // --- 6b. hovering a row shows its tip pair, and the tip text never reaches a mirror ------------
  // The tips are GAME nodes (the set parents under the game's own tips container, outside the stamped
  // CouchCoop subtree) — which is exactly why their text is scanned on the mirror stream here, while
  // the hover is held open: an unstamped set would leak join URLs to every phone.
  await hoverNode(at(panelPath, `${DIALOG_PANEL}/${NAMES.hostSelect}/${NAMES.hostSelectList}/${NAMES.optionPrefix}1`));
  await sleep(400);
  const treeWithTips = await sceneTree();
  const tipNodes = (treeWithTips.nodes ?? []).filter(node =>
    /hover_?tip/i.test(node.name) || /NHoverTipSet/.test(node.nodeType ?? ""));
  assert(tipNodes.length >= 1, "hovering an option row must show the game-native hover-tip set");
  await shot("03b-row-hover-tips.png", `hover-tip pair for the web-link row (${webLabel})`);

  const tipScan = await scanMirrorForQrNodes({
    ...mirrorScanOptions(),
    durationMs: 6000,
    extraPatterns: [/sts2-couch\.pages\.dev/g, /local-ip\.co/g, /Wired \(Ethernet\)/g, /Plain address/g]
  });
  assert(!tipScan.socketError, `tip-leak mirror scan could not connect: ${tipScan.socketError}`);
  assert(tipScan.sawFullKeyframe,
    `tip-leak mirror scan never saw a full keyframe to scan (${describeScan(tipScan)})`);
  assert(tipScan.matches.length === 0,
    `hover-tip content leaked to a mirror client: ${tipScan.matches.join(", ")} — the created NHoverTipSet must be stream-skip stamped`);
  record("hover-tips", { tipNodes: tipNodes.map(node => node.name), tipScanMessages: tipScan.messages, tipScanMatches: tipScan.matches });

  // --- 6c. switch to the LAST (mdns) option -> URL + QR both change ------------------------------
  await hoverAndClick(at(panelPath, `${DIALOG_PANEL}/${NAMES.hostSelect}/${NAMES.hostSelectList}/${lastOption}`));
  await sleep(700);

  const switchedUrl = textOf(await nodeDetails(at(panelPath, `${DIALOG_PANEL}/${NAMES.urlLabel}`), { transform: false }));
  assert(switchedUrl !== defaultUrl, "picking a different option must change the URL label");
  assert(switchedUrl === `http://${mdnsLabel}/`, `URL must follow the picked option, expected http://${mdnsLabel}/ got ${switchedUrl}`);

  const qrAfter = await shot("04-dialog-switched-to-mdns.png", `option switched to ${mdnsLabel}; QR re-rendered`);

  // Prove the QR PIXELS changed, over the QR's own rect only.
  const roiPixels = designRectToPixels(
    { x: qrRect.position.x, y: qrRect.position.y, width: qrRect.size.x, height: qrRect.size.y },
    qrAfter
  );
  const regionsPath = relArtifact("qr-roi.json");
  await writeFile(new URL("qr-roi.json", artifactDir), `${JSON.stringify({ regions: [{ id: "qr", ...roiPixels }] }, null, 2)}\n`);
  const roi = await roiDiffRatio(qrBefore.path, qrAfter.path, regionsPath);
  assert(roi.diffRatio > 0.05, `the QR region should visibly re-render on a host switch; ROI diff ratio was only ${roi.diffRatio}`);

  record("option-switch", {
    optionNames, switchedOption: lastOption, switchedLabel: mdnsLabel, switchedUrl,
    qrRoiPixels: roiPixels,
    qrRoiDiffRatio: roi.diffRatio,
    qrRoiDiffPixels: roi.diffPixels,
    baseline: qrBefore.path,
    actual: qrAfter.path
  });

  // --- 7. close via the Close BUTTON -----------------------------------------------------------
  await hoverAndClick(at(panelPath, `${DIALOG_PANEL}/${NAMES.closeButton}`));
  await sleep(500);
  assert(!(await dialogVisible(panelPath)), "the Close QR Code button must close the dialog");
  await shot("05-dialog-closed-via-button.png", "dialog closed by its Close QR Code button");
  record("close-via-button", { closed: true });

  // --- 8. input blocking, asserted on the INPUT path -------------------------------------------
  // A lobby control that is cheap to observe and reversible: the character buttons drive
  // characterSelect.view.selectedCharacterButtonId.
  const lobbyTree = await sceneTree();
  const characterButtons = (lobbyTree.nodes ?? []).filter(node => /_button$/.test(node.name) && node.nodeType.endsWith("NCharacterSelectButton"));
  assert(characterButtons.length >= 2, `need >=2 character buttons for the input-blocking leg, found ${characterButtons.length}`);

  const selectedBefore = await selectedCharacterButtonId();
  const target = characterButtons.find(node => node.name !== `${selectedBefore}_button`);
  assert(target, `could not find a character button other than the selected ${selectedBefore}`);
  const targetCharacter = target.name.replace(/_button$/, "");

  // (a) with the dialog CLOSED the control works -> the click coords are known-good
  const targetClick = await hoverAndClick(target.nodePath);
  await sleep(600);
  const afterUnblocked = await selectedCharacterButtonId();
  assert(afterUnblocked === targetCharacter, `baseline: clicking ${targetCharacter} should select it, got ${afterUnblocked}`);

  // (b) reopen the dialog and click the SAME coords -> nothing may change
  await hoverAndClick(at(panelPath, NAMES.button));
  await sleep(600);
  assert(await dialogVisible(panelPath), "the dialog must reopen for the blocking leg");
  await shot("07-dialog-blocks-lobby-input.png", `dialog open over the lobby; a click on the ${selectedBefore} character button must not register`);

  const blockedTargetNode = characterButtons.find(node => node.name === `${selectedBefore}_button`) ?? characterButtons[0];
  const blockedRect = globalRect(await nodeDetails(blockedTargetNode.nodePath, { properties: false }));
  const blockedX = blockedRect.position.x + blockedRect.size.x / 2;
  const blockedY = blockedRect.position.y + blockedRect.size.y / 2;
  const blockedCharacter = blockedTargetNode.name.replace(/_button$/, "");

  const beforeBlockedClick = await selectedCharacterButtonId();
  await clickAt(blockedX, blockedY);
  await sleep(700);
  const afterBlockedClick = await selectedCharacterButtonId();
  assert(
    afterBlockedClick === beforeBlockedClick,
    `while the dialog is open a lobby click must change nothing, but selection went ${beforeBlockedClick} -> ${afterBlockedClick}`
  );

  // The character buttons sit UNDER the card (the 936-tall card spans y 72..1008; the button row is
  // centred near y 948), so the blocked click above proves blocking but is NOT an outside click. The
  // pre-redesign card let card-surface clicks fall through to the scrim — which is why one click used
  // to prove both — but the single-select card consumes them (clicking blank card space must not
  // dismiss the dialog under a player's finger). The outside-click close needs its own point.
  assert(await dialogVisible(panelPath), "a blocked lobby click on the card surface must NOT close the dialog");
  const { point: outside, surfaces: dialogSurfaces } = await bareScrimPoint(at(panelPath, DIALOG));
  await clickAt(outside.x, outside.y);
  await sleep(500);
  assert(!(await dialogVisible(panelPath)), "a click outside the dialog card must close the dialog");
  record("close-via-outside-click", {
    closed: true,
    clickedAt: outside,
    from: outside.from,
    dialogSurfaces,
    blockedCardSurfaceClick: { x: blockedX, y: blockedY, note: "consumed by the card, dialog stayed open" }
  });

  // (c) the identical click now works -> the block was the dialog, not a broken control
  await clickAt(blockedX, blockedY);
  await sleep(700);
  const afterReenabled = await selectedCharacterButtonId();
  assert(
    afterReenabled === blockedCharacter,
    `once the dialog is closed the same click must work again; expected ${blockedCharacter}, got ${afterReenabled}`
  );

  record("input-blocking", {
    baselineClick: { node: target.nodePath, at: targetClick, selected: afterUnblocked },
    blockedClick: { at: { x: blockedX, y: blockedY }, before: beforeBlockedClick, after: afterBlockedClick },
    afterClose: { expected: blockedCharacter, actual: afterReenabled }
  });

  return { panelPath, defaultOption, defaultUrl };
}

// =================================================================================================
// Step 9 -- the load-run host lobby carries the SAME button at the SAME rect
// =================================================================================================
async function assertLoadRunLobby() {
  const panelPath = await loadLobbyFixtureStable(FIXTURE_LOAD_RUN_HOST_LOBBY, SCREEN_LOAD_RUN_LOBBY);

  const button = await nodeDetails(at(panelPath, NAMES.button));
  assertRect(globalRect(button), BUTTON_RECT, "load-run lobby QR button");
  assert(isVisible(button), "the QR button must be visible on the load-run host lobby");

  // The whole point of the load screen leg: same rect, different screen origin.
  await shot("06-load-run-lobby-button.png", `load-run host lobby: button at the SAME ${BUTTON_RECT.x},${BUTTON_RECT.y}`);
  record("button-rect-load-run", { screen: SCREEN_LOAD_RUN_LOBBY, rect: globalRect(button), panelPath });

  // It must still open here -- the dialog is per-panel, and there are two panels this session.
  const openClick = await hoverAndClick(at(panelPath, NAMES.button));
  await sleep(600);
  assert(await dialogVisible(panelPath), "the QR button must also open the dialog on the load-run lobby");
  await hoverAndClick(at(panelPath, `${DIALOG_PANEL}/${NAMES.closeButton}`));
  await sleep(400);
  assert(!(await dialogVisible(panelPath)), "the load-run dialog must close again");
  record("load-run-dialog", { openClick, openedAndClosed: true });
}

// =================================================================================================
// Step 10 -- nothing from the CouchCoopQr* family may reach a mirror client
// =================================================================================================
/**
 * A viewer held open for the mirror-exclusion scan, so the connections panel is actually POPULATED while the
 * stream is being watched. Named distinctively only so it is recognisable in a capture.
 */
const SCAN_WITNESS_VIEWER = "ZzWitnessViewer";

async function assertMirrorExclusion() {
  // Run it on a host lobby, where the panel definitely exists in the game tree.
  const panelPath = await loadLobbyFixtureStable(FIXTURE_HOST_LOBBY, SCREEN_START_RUN_LOBBY);
  const tree = await sceneTree();
  const inGameTree = (tree.nodes ?? []).filter(node => node.name.startsWith("CouchCoopQr")).map(node => node.name);
  assert(inGameTree.length >= 5, `the panel subtree should be visible to dev inspection, found ${inGameTree.length}`);

  // A SECOND viewer, held open for the scan, and it is the point of this leg rather than decoration: a live
  // row is what puts the connections panel on screen with a player's NAME in it. That panel is a sibling of
  // the QR card inside the same stamped subtree, so the only thing keeping one player's name off every other
  // player's phone is the stream-skip stamp. This leg inherited that duty from the retired activity-log
  // probe, whose panel the connections panel replaced.
  const witness = await holdViewer(SCAN_WITNESS_VIEWER, mirrorOrigin);
  let scan;
  try {
    scan = await scanMirrorForQrNodes({
      ...mirrorScanOptions(),
      durationMs: 8000,
      // `CouchCoopConnection*` is NOT covered by the CouchCoopQr* default -- the two families share a stamped
      // root and nothing else, so the older pattern would have watched a leak of the whole roster go past.
      extraPatterns: [/CouchCoopConnection[A-Za-z0-9_]*/g]
    });
  } finally {
    witness.close();
  }

  assert(!scan.socketError, `mirror scan could not connect: ${scan.socketError}`);
  assert(scan.messages > 0, "mirror scan received no messages -- is the browser server up?");
  assert(scan.sawFullKeyframe,
    `mirror scan never saw a full keyframe ("full":true) to scan (${describeScan(scan)})`);
  assert(
    scan.matches.length === 0,
    `host-only content leaked to a mirror client: ${scan.matches.join(", ")}. ` +
    "A phone that can see the button can PRESS it (mirror input is injected into the host), and a phone " +
    "that can see the connections panel can read every other player's name."
  );

  record("mirror-exclusion", {
    url: scan.url,
    messages: scan.messages,
    bytes: scan.bytes,
    fullKeyframeBytes: scan.fullKeyframeBytes,
    couchCoopQrNamesInGameTree: inGameTree.length,
    hostOnlyMatchesOnMirror: scan.matches.length,
    witnessViewer: { name: SCAN_WITNESS_VIEWER, sawSession: witness.sawSession },
    scannedFamilies: ["CouchCoopQr*", "CouchCoopConnection*"],
    whyTheNameIsNotAsserted:
      "The retired activity-log probe also asserted that the viewer's NAME never appeared. That cannot be " +
      "carried over honestly, and both halves were measured here. While the viewer is LIVE its name is on " +
      "the wire legitimately -- the game's own lobby NameplateLabel, which every player is meant to see. " +
      "Once it disconnects, the host holds the name NOWHERE (the connections panel keeps only its title), " +
      "so asserting absence then passes whatever the stamp does. The node-family check above is the part " +
      "that still bites: a leaked connections row arrives under CouchCoopConnectionPanel.",
    positiveControl:
      "Scan sensitivity was verified out-of-band by relaunching with " +
      "SPIRECTL_SCENE_WATCH_HONOR_STREAM_SKIP=0, which makes the CouchCoopQr*/CouchCoopConnection* names " +
      "and the canary viewer's name all appear on this same stream -- so a zero here is an exclusion, " +
      "not a blind spot.",
    panelPath
  });
}

// =================================================================================================
// The remembered selection (qr-prefs.json) is read PER DIALOG OPEN, and a persisted pick — including
// a legacy checkbox-era `{"mode":"web"}` store, which the redesign deliberately migrates to the web
// row — replaces the dialog's own default. The step-5 "default is a plain IPv4" assertion is only
// meaningful on an ABSENT store, so the probe stashes the file for the run and puts it back after
// (which also undoes the prefs the probe's own row switches persist mid-run).
// =================================================================================================
const qrPrefsPath = process.env.COUCHCOOP_QR_PREFS
  ?? join(homedir(), ".local", "share", "SlayTheSpire2", "couch-coop", "qr-prefs.json");
const qrPrefsStash = `${qrPrefsPath}.probe-stash`;
let qrPrefsStashed = false;

async function stashQrPrefs() {
  try {
    await rename(qrPrefsPath, qrPrefsStash);
    qrPrefsStashed = true;
    record("qr-prefs-stashed", { path: qrPrefsPath, stash: qrPrefsStash });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    record("qr-prefs-stashed", { path: qrPrefsPath, note: "no pre-existing store; nothing to stash" });
  }
}

async function restoreQrPrefs() {
  // The probe's own row switches wrote a fresh store; the player's original (or its absence) wins.
  await rm(qrPrefsPath, { force: true });
  if (qrPrefsStashed) {
    await rename(qrPrefsStash, qrPrefsPath);
    qrPrefsStashed = false;
  }
}

// =================================================================================================
// main
// =================================================================================================
let lock = null;
try {
  await mkdir(artifactDir, { recursive: true });
  // A failure.json left by an earlier run would otherwise be mistaken for this run's outcome.
  await rm(new URL("failure.json", artifactDir), { force: true });
  lock = await acquireLiveLock("pc-lobby-qr-probe");
  record("live-lock", lock);
  await stashQrPrefs();

  await assertNegativeGate();
  const startRun = await assertStartRunLobby();
  await assertLoadRunLobby();
  await assertMirrorExclusion();

  const result = {
    ok: true,
    defaultHostOption: startRun.defaultOption,
    defaultJoinUrl: startRun.defaultUrl,
    assertions: {
      liveLock: "ok",
      negativeGateNonHostScreen: "ok",
      buttonRectStartRunLobby: "ok",
      buttonRectLoadRunLobby: "ok",
      dialogOpensOnClick: "ok",
      defaultOptionIsPlainIpv4: "ok",
      mdnsRowIsLast: "ok",
      hoverTipPairShown: "ok",
      hoverTipTextMirrorExclusion: "ok",
      optionSwitchChangesUrlAndQr: "ok",
      dialogBlocksLobbyInput: "ok",
      closeViaButton: "ok",
      closeViaOutsideClick: "ok",
      mirrorExclusion: "ok"
    },
    // Non-fatal, but tracked: >0 means the controller rebuilt the panel mid-session, which for a real
    // player would close the dialog under their hands. See the "panel-reinstalled" evidence entries.
    panelReinstallsObserved: panelReinstalls,
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
  try {
    await restoreQrPrefs();
  } catch (error) {
    console.error(`could not restore ${qrPrefsPath}: ${error?.message}`);
  }
  await releaseLiveLock(lock);
}
