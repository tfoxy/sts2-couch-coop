#!/usr/bin/env node
//
// Live probe: the WS-2 QR host panel must not REPLACE or BLOCK the lobby's semantic actions.
//
// Structure is three legs -- available -> blocked -> available:
//   A. dialog CLOSED : lobby semantic actions are advertised and execute, and a raw click on a lobby
//                      control lands (the panel root is MouseFilter.Ignore, so it is inert)
//   B. dialog OPEN   : the raw click no longer lands (the scrim is MouseFilter.Stop and covers the
//                      screen) -- but the SEMANTIC actions are still advertised and still execute
//   C. dialog CLOSED : the raw click lands again, so B blocked input rather than breaking the lobby
//
// Leg B's split is the whole point of this probe. Semantic actions go through the bridge, not through
// Godot's input stack, so a modal dialog must NOT take them away -- a browser player has to stay able
// to pick a character while the host happens to have the QR up. Only physical input is captured.
//
// Why the mouse filters are checked in SOURCE and not live: `dev scene node --properties` does not
// expose `mouseFilter` at all (verified 2026-08-08 -- it exists only in spirectl's mirror scene
// WATCHER, never in the dev scene provider). The pre-2026-08 version of this probe "asserted" the
// filter with `mouseFilter === undefined || ...`, which passed vacuously on every run. The real
// behaviour is therefore asserted on the INPUT path below, and the declared filters are guarded
// against source drift by a regex over the CURRENT files.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  NAMES, SCREEN_START_RUN_LOBBY, FIXTURE_HOST_LOBBY,
  ProbeError, assert, sleep,
  acquireLiveLock, releaseLiveLock,
  sts2, sceneTree, nodesNamed, findNodePath, nodeDetails, globalRect, isVisible,
  hoverAndClick, clickAt,
  loadFixture, waitFor, selectedCharacterButtonId,
  screenshot
} from "./probe-lib-lobby-qr.mjs";

const artifactDir = new URL("../.sts2/artifacts/lobby-actions-remain-available/", import.meta.url);
const artifactDirPath = fileURLToPath(artifactDir);

const evidence = { legs: {}, source: {}, actions: {} };
const screenshots = [];

async function shot(name, note) {
  const path = `.sts2/artifacts/lobby-actions-remain-available/${name}`;
  const taken = await screenshot(path);
  screenshots.push({ name, path: `${artifactDirPath}${name}`, note });
  return taken;
}

const at = (panelPath, suffix) => `${panelPath}/${suffix}`;
const DIALOG_PANEL = `${NAMES.dialog}/${NAMES.dialogPanel}`;

async function dialogVisible(panelPath) {
  return isVisible(await nodeDetails(at(panelPath, NAMES.dialog), { transform: false }));
}

// =================================================================================================
// Static contract: the declared mouse filters of the injected tree
// =================================================================================================
async function assertDeclaredMouseFilters() {
  const read = async relative => await readFile(new URL(`../${relative}`, import.meta.url), "utf8");

  const panelSource = "src/CouchCoop.Mod/HostUi/CouchCoopQrHostPanel.cs";
  const dialogSource = "src/CouchCoop.Mod/HostUi/CouchCoopQrDialog.cs";
  const panel = await read(panelSource);
  const dialog = await read(dialogSource);

  // The panel ROOT must be inert, or it would swallow lobby clicks whenever only the button shows.
  assert(
    /MouseFilter\s*=\s*MouseFilterEnum\.Ignore/.test(panel),
    `${panelSource}: the panel root must be MouseFilterEnum.Ignore so the lobby stays clickable`
  );
  // The dialog root is Ignore too; the SCRIM is what blocks.
  assert(
    /_scrim\.MouseFilter\s*=\s*MouseFilterEnum\.Stop/.test(dialog),
    `${dialogSource}: the scrim must be MouseFilterEnum.Stop so an open dialog captures lobby clicks`
  );
  assert(
    /_panel\.MouseFilter\s*=\s*MouseFilterEnum\.Stop/.test(dialog),
    `${dialogSource}: the dialog card must be MouseFilterEnum.Stop`
  );
  assert(
    /_qr\.MouseFilter\s*=\s*MouseFilterEnum\.Stop/.test(dialog),
    `${dialogSource}: the QR itself must be Stop so lining a phone up over it does not dismiss the dialog`
  );

  evidence.source = {
    panelSource,
    dialogSource,
    panelRoot: "MouseFilterEnum.Ignore",
    scrim: "MouseFilterEnum.Stop",
    dialogCard: "MouseFilterEnum.Stop",
    qrTexture: "MouseFilterEnum.Stop",
    note:
      "Checked in source because `dev scene node --properties` does not expose mouseFilter; the live " +
      "behaviour these filters produce is asserted on the input path in legs A/B/C."
  };
}

// =================================================================================================
// Semantic actions
// =================================================================================================
async function semanticActions() {
  const payload = await sts2(["state", "actions"]);
  return payload?.actions ?? [];
}

function findAction(actions, kind, predicate = () => true) {
  return actions.find(action => action?.kind === kind && action?.enabled !== false && predicate(action));
}

function stableIds(actions) {
  return actions.map(action => action?.id).filter(Boolean);
}

/** Asserts the lobby's semantic surface is intact and returns it. */
async function assertSemanticActionsAdvertised(label) {
  const actions = await semanticActions();
  const ids = stableIds(actions);

  const selectCharacter = findAction(actions, "select-character");
  assert(selectCharacter, `${label}: missing an enabled select-character action; advertised: ${ids.join(", ")}`);
  assert(
    /^action:lobby:select-character:[A-Za-z0-9_-]+$/.test(selectCharacter.id),
    `${label}: select-character id is not stable: ${selectCharacter.id}`
  );

  const readyOrUnready = findAction(actions, "ready") ?? findAction(actions, "unready");
  assert(readyOrUnready, `${label}: missing an enabled ready/unready action; advertised: ${ids.join(", ")}`);
  assert(
    /^action:lobby:(ready|unready)$/.test(readyOrUnready.id),
    `${label}: ready/unready id is not stable: ${readyOrUnready.id}`
  );

  evidence.actions[label] = { advertisedIds: ids, selectCharacter: selectCharacter.id, readyOrUnready: readyOrUnready.id };
  return { actions, selectCharacter, readyOrUnready };
}

/** Executes select-character then ready/unready, proving the actions are not merely advertised. */
async function assertSemanticActionsExecute(label) {
  const { actions, selectCharacter } = await assertSemanticActionsAdvertised(label);
  const owner = selectCharacter.ownerPlayerId ?? selectCharacter.args?.playerId;
  assert(owner, `${label}: select-character has no owner player id`);

  // Re-selecting the character that is ALREADY selected is refused with reasonCode "not_visible"
  // (the game only offers a move to a different card), so pick a genuinely different one.
  // RANDOM_CHARACTER is skipped because it resolves to an arbitrary character and would make the
  // follow-up observable non-deterministic.
  const current = await selectedCharacterButtonId();
  const movable = actions.find(action =>
    action.kind === "select-character"
    && action.enabled !== false
    && action.args?.characterId
    && action.args.characterId !== current
    && action.args.characterId !== "RANDOM_CHARACTER");
  assert(movable, `${label}: no select-character action targets a character other than the current ${current}`);

  const characterId = movable.args.characterId;
  const selection = await sts2(["act", "select-character", "--player-id", owner, "--character", characterId]);
  assert(selection?.accepted === true, `${label}: select-character was not accepted`);

  // ready -> unready round trip, so the probe leaves the lobby exactly as it found it.
  const ready = findAction(await semanticActions(), "ready");
  if (ready) {
    const readyResult = await sts2(["act", "ready", "--player-id", owner]);
    assert(readyResult?.accepted === true, `${label}: ready was not accepted`);
    await sleep(400);
    const unready = findAction(await semanticActions(), "unready");
    assert(unready, `${label}: unready must become available after ready`);
    const unreadyResult = await sts2(["act", "unready", "--player-id", owner]);
    assert(unreadyResult?.accepted === true, `${label}: unready was not accepted`);
    await sleep(400);
  }

  evidence.actions[`${label}:executed`] = {
    selectCharacter: `${owner} -> ${characterId}`,
    readyRoundTrip: Boolean(ready),
    advertised: stableIds(actions).length
  };
}

// =================================================================================================
// main
// =================================================================================================
let lock = null;
try {
  await mkdir(artifactDir, { recursive: true });
  await rm(new URL("failure.json", artifactDir), { force: true });
  lock = await acquireLiveLock("lobby-actions-probe");
  evidence.liveLock = lock;

  await assertDeclaredMouseFilters();

  // Load the lobby and prove it STAYS. A freshly restarted game finishes its boot flow (logo / FTUE /
  // leaderboard) a few seconds in, and that flow pushes the main menu -- popping a lobby the fixture
  // loader had just created, which would otherwise surface as an opaque "node path not found".
  let tree = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await loadFixture(FIXTURE_HOST_LOBBY);
    await waitFor(
      () => sceneTree(),
      value => value?.screen?.id === SCREEN_START_RUN_LOBBY && nodesNamed(value, NAMES.panel).length > 0,
      { attempts: 40, intervalMs: 250, what: `${NAMES.panel} on the host lobby` }
    );
    await sleep(3000);
    tree = await sceneTree();
    if (tree?.screen?.id === SCREEN_START_RUN_LOBBY && nodesNamed(tree, NAMES.panel).length === 1) {
      evidence.lobbyLoadAttempts = attempt;
      break;
    }
    tree = null;
    await sleep(2000);
  }
  assert(tree, "the host lobby fixture never held the lobby screen -- let the game finish booting first");
  const panelPath = findNodePath(tree, NAMES.panel);
  evidence.panelPath = panelPath;

  // A lobby control to drive with RAW input, and a reversible observable for it.
  const characterButtons = (tree.nodes ?? []).filter(
    node => /_button$/.test(node.name) && node.nodeType.endsWith("NCharacterSelectButton")
  );
  assert(characterButtons.length >= 2, `need >=2 character buttons, found ${characterButtons.length}`);

  // ---------------------------------------------------------------------------------------------
  // LEG A -- dialog closed: actions available, raw input lands
  // ---------------------------------------------------------------------------------------------
  assert(!(await dialogVisible(panelPath)), "leg A expects the dialog closed");
  await assertSemanticActionsExecute("A-available");

  const selectedBefore = await selectedCharacterButtonId();
  const rawTarget = characterButtons.find(node => node.name !== `${selectedBefore}_button`) ?? characterButtons[0];
  const rawCharacter = rawTarget.name.replace(/_button$/, "");
  await hoverAndClick(rawTarget.nodePath);
  await sleep(600);
  const afterRawA = await selectedCharacterButtonId();
  assert(
    afterRawA === rawCharacter,
    `leg A: a raw click on ${rawCharacter} must land while only the button shows (panel root is Ignore); got ${afterRawA}`
  );
  const rawRect = globalRect(await nodeDetails(rawTarget.nodePath, { properties: false }));
  const rawX = rawRect.position.x + rawRect.size.x / 2;
  const rawY = rawRect.position.y + rawRect.size.y / 2;

  await shot("01-leg-a-actions-available.png", "leg A: dialog closed, lobby actions available and raw input lands");
  evidence.legs.A = { rawClickTarget: rawTarget.nodePath, rawClickAt: { x: rawX, y: rawY }, selected: afterRawA };

  // ---------------------------------------------------------------------------------------------
  // LEG B -- dialog open: raw input blocked, semantic actions STILL available
  // ---------------------------------------------------------------------------------------------
  await hoverAndClick(at(panelPath, NAMES.button));
  await sleep(600);
  assert(await dialogVisible(panelPath), "leg B: the QR button must open the dialog");
  await shot("02-leg-b-dialog-open.png", "leg B: dialog open over the lobby");

  // Semantic actions must survive the modal -- a browser player still has to be able to act.
  await assertSemanticActionsExecute("B-blocked-input-but-actions-available");

  // Re-open if the ready round trip closed nothing; the dialog should still be up.
  assert(await dialogVisible(panelPath), "leg B: semantic actions must not close the dialog");

  const beforeRawB = await selectedCharacterButtonId();
  const blockedTarget = characterButtons.find(node => node.name !== `${beforeRawB}_button`) ?? characterButtons[0];
  const blockedRect = globalRect(await nodeDetails(blockedTarget.nodePath, { properties: false }));
  const blockedX = blockedRect.position.x + blockedRect.size.x / 2;
  const blockedY = blockedRect.position.y + blockedRect.size.y / 2;
  const blockedCharacter = blockedTarget.name.replace(/_button$/, "");

  await clickAt(blockedX, blockedY);
  await sleep(700);
  const afterRawB = await selectedCharacterButtonId();
  assert(
    afterRawB === beforeRawB,
    `leg B: a raw click at (${blockedX},${blockedY}) must be captured by the scrim, but selection moved ${beforeRawB} -> ${afterRawB}`
  );
  // That click also dismissed the dialog (click-outside-to-close).
  assert(!(await dialogVisible(panelPath)), "leg B: the outside click must also close the dialog");
  evidence.legs.B = {
    rawClickAt: { x: blockedX, y: blockedY },
    selectionBefore: beforeRawB,
    selectionAfter: afterRawB,
    blocked: true,
    closedByOutsideClick: true
  };

  // ---------------------------------------------------------------------------------------------
  // LEG C -- dialog closed again: the same raw click lands
  // ---------------------------------------------------------------------------------------------
  await clickAt(blockedX, blockedY);
  await sleep(700);
  const afterRawC = await selectedCharacterButtonId();
  assert(
    afterRawC === blockedCharacter,
    `leg C: with the dialog closed the identical click must land; expected ${blockedCharacter}, got ${afterRawC}`
  );
  await assertSemanticActionsExecute("C-available-again");
  await shot("03-leg-c-actions-available-again.png", "leg C: dialog closed, raw input lands again");
  evidence.legs.C = { rawClickAt: { x: blockedX, y: blockedY }, selected: afterRawC, restored: true };

  const result = {
    ok: true,
    assertions: {
      declaredMouseFilters: "ok",
      legA_actionsAvailableAndInputLands: "ok",
      legB_inputBlockedButActionsAvailable: "ok",
      legC_inputRestored: "ok",
      selectCharacter: "ok",
      ready: "ok",
      unready: "ok"
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
  } catch { /* artifact dir may be missing */ }
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await releaseLiveLock(lock);
}
