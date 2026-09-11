// Shared helpers for the two live PC-host-lobby probes.
//
// Both probes drive the REAL game through `sts2`, so everything here is written against the live CLI
// shapes verified on 2026-08-08:
//   * `dev scene tree [path]`  -> { screen: {id}, nodes: [ {name, nodePath, nodeType, properties?} ] }
//     (FLAT node list -- not a nested tree; the pre-2026-08 probes walked `children` and found nothing)
//   * `dev scene node <path>`  -> { node: { properties, computedTransform } }
//   * `dev scene hover --path` -> { hovered, hoverPosition: {x,y} }  <- CANVAS/design coords
//   * `act mouse click --x --y` takes the SAME canvas coords (it maps to the window itself) and needs
//     `--mode dangerous`.
//
// MODE: `dangerous` is the default below, not a per-call opt-in. These helpers used to default to
// `--mode dev`, which the CLI no longer accepts (`normal|dangerous` only) — so BOTH lobby scenarios
// failed on their very first fixture load with `invalid value 'dev' for '--mode'`, before asserting
// anything. Fixture loads and input both need `dangerous` anyway, and every caller here does one or
// the other.
//
// The hover-then-click-at-hoverPosition pattern is mandatory, not stylistic: NClickableControl only
// acts on a click when it is already focused (mouse_entered), and clicking a guessed centre lands on
// the wrong node -- during development a guessed y closed the option list instead of picking a row.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { acquireLease, assertLease, releaseLease } from "./live-qa-lock.mjs";
import { SPIRECTL_ROOT } from "./lib/repo-layout.mjs";

export const REPO_ROOT = new URL("..", import.meta.url);

/** The game's design space. Node rects and click coords are both expressed in it. */
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

export const SCREEN_START_RUN_LOBBY = "Screens.CharacterSelect.NCharacterSelectScreen";
export const SCREEN_LOAD_RUN_LOBBY = "Screens.CharacterSelect.NMultiplayerLoadGameScreen";

export const FIXTURE_HOST_LOBBY = "tests/fixtures/pc-lobby-host.sts2.fixture.yaml";
export const FIXTURE_LOAD_RUN_HOST_LOBBY = "tests/fixtures/pc-lobby-load-run-host.sts2.fixture.yaml";
/** Non-lobby screen used for the negative gate. Lives in the sibling spirectl checkout. */
export const FIXTURE_MAIN_MENU = resolve(SPIRECTL_ROOT, "fixtures/basic-main-menu.sts2.fixture.yaml");

/**
 * Node-name contract (src/CouchCoop.Mod/HostUi/). Kept in one place so both probes agree.
 *
 * The four structural names -- dialog, scrim, dialogPanel, closeButton -- are passed into the shared
 * `CouchCoopModalDialog` as a `CouchCoopModalNames` value rather than derived from the type, precisely so
 * extracting that base class could not rename them out from under these probes.
 */
export const NAMES = {
  panel: "CouchCoopQrHostPanel",
  button: "CouchCoopQrButton",
  dialog: "CouchCoopQrDialog",
  scrim: "CouchCoopQrDialogScrim",
  dialogPanel: "CouchCoopQrDialogPanel",
  title: "CouchCoopQrDialogTitleLabel",
  qrTexture: "CouchCoopQrDialogQrTexture",
  urlLabel: "CouchCoopQrDialogUrlLabel",
  noticeLabel: "CouchCoopQrDialogNoticeLabel",
  closeButton: "CouchCoopQrCloseButton",
  hostSelect: "CouchCoopQrHostSelect",
  hostSelectCurrent: "CouchCoopQrHostSelectCurrent",
  hostSelectList: "CouchCoopQrHostSelectList",
  optionPrefix: "CouchCoopQrHostOption"
};

/**
 * The Steam-offline modal, a sibling of the QR dialog under the same panel root.
 *
 * HEADS UP for anyone driving these probes against a live host: this pops automatically, once per lobby
 * mount, whenever `CouchCoopHostUiNotices.HostTransportNote` is set (Steam initialised but offline). Its
 * scrim is a full-rect `Stop`, so while it is up the QR BUTTON is unreachable -- dismiss it first. That is
 * the real host experience, not a probe artefact.
 */
export const ALERT_NAMES = {
  dialog: "CouchCoopHostTransportAlert",
  scrim: "CouchCoopHostTransportAlertScrim",
  dialogPanel: "CouchCoopHostTransportAlertPanel",
  title: "CouchCoopHostTransportAlertTitleLabel",
  bodyLabel: "CouchCoopHostTransportAlertBodyLabel",
  dismissButton: "CouchCoopHostTransportAlertDismissButton"
};

export const ALERT_TITLE_TEXT = "Heads up";
export const ALERT_DISMISS_TEXT = "Continue";

/** Button rect in design space -- the WS-2 layout contract (HostLobbyQrOverlayLayout.Default). */
export const BUTTON_RECT = { x: 226, y: 732, width: 352, height: 136 };

export const BUTTON_TEXT = "Couch Co-Op QR Code";
export const CLOSE_BUTTON_TEXT = "Close QR Code";
export const DIALOG_TITLE_TEXT = "Scan to join Couch Co-Op";

// ---------------------------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------------------------

export async function run(command, args, options = {}) {
  const proc = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DOTNET_ROLL_FORWARD: "Major" },
    ...options
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(proc, "exit");
  return { code, stdout, stderr, command: [command, ...args].join(" ") };
}

/** Runs `sts2` and parses JSON. Throws ProbeError on a nonzero exit or unparseable output. */
export async function sts2(args, { mode = "dangerous" } = {}) {
  const result = await run("sts2", ["--mode", mode, "--json", ...args]);
  if (result.code !== 0) {
    throw new ProbeError(`${result.command} failed: ${(result.stderr || result.stdout).slice(0, 800)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new ProbeError(`${result.command} did not emit JSON: ${error.message}`);
  }
}

/**
 * Like {@link sts2} but tolerates a nonzero exit and still parses the JSON body.
 * `dev screenshot-diff` exits nonzero whenever images differ -- which for the QR-changed assertion is
 * the EXPECTED outcome, so the payload has to be readable on the failure path too.
 */
export async function sts2Tolerant(args, { mode = "dangerous" } = {}) {
  const result = await run("sts2", ["--mode", mode, "--json", ...args]);
  try {
    return { ok: result.code === 0, value: JSON.parse(result.stdout), result };
  } catch {
    return { ok: false, value: null, result };
  }
}

export class ProbeError extends Error {}

export function assert(condition, message) {
  if (!condition) {
    throw new ProbeError(message);
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// live-session lock (docs/agents/qa-recipes.md section 1)
// ---------------------------------------------------------------------------------------------

/**
 * Acquires or inherits the exact resources these probes drive: the default game and a shared installed mod.
 */
export async function acquireLiveLock(owner) {
  const inheritedOwner = process.env.COUCHCOOP_LIVEQA_OWNER;
  const inheritedPid = Number(process.env.COUCHCOOP_LIVEQA_PID ?? 0);
  const resources = ["shared:install", "exclusive:game:default"];
  if (inheritedOwner && inheritedPid > 0) {
    assertLease({ owner: inheritedOwner, pid: inheritedPid, resources });
    return { held: true, owned: false, holder: inheritedOwner, pid: inheritedPid, note: "inherited scoped leases" };
  }
  acquireLease({ owner, pid: process.pid, resources });
  return { held: true, owned: true, holder: owner, pid: process.pid, note: "acquired scoped leases" };
}

/** Releases the lock only if THIS probe created it. Safe to call on error paths. */
export async function releaseLiveLock(lock) {
  if (!lock?.owned) {
    return;
  }
  try {
    releaseLease({ owner: lock.holder, pid: lock.pid });
  } catch {
    // best effort -- a stuck lock is worse than a noisy probe, but we cannot do better here
  }
}

// ---------------------------------------------------------------------------------------------
// scene queries
// ---------------------------------------------------------------------------------------------

/** Full flat scene tree, plus the live screen id. */
export async function sceneTree(path) {
  return await sts2(["dev", "scene", "tree", ...(path ? [path] : [])]);
}

export async function sceneTreeWithProperties(path) {
  return await sts2(["dev", "scene", "tree", ...(path ? [path] : []), "--properties"]);
}

export async function currentScreenId() {
  const tree = await sts2(["dev", "scene", "tree"]);
  return tree?.screen?.id ?? null;
}

export function nodesNamed(tree, name) {
  return (tree?.nodes ?? []).filter(node => node.name === name);
}

export function findNodePath(tree, name) {
  return nodesNamed(tree, name)[0]?.nodePath ?? null;
}

export async function nodeDetails(path, { properties = true, transform = true } = {}) {
  const args = ["dev", "scene", "node", path];
  if (properties) args.push("--properties");
  if (transform) args.push("--computed-transform");
  const payload = await sts2(args);
  return payload?.node ?? null;
}

export function globalRect(node) {
  return node?.computedTransform?.globalRect ?? null;
}

export function isVisible(node) {
  return node?.properties?.visible === true;
}

export function isEffectivelyVisible(node) {
  return node?.properties?.effectiveVisible === true;
}

/** `properties.text` is an object whose `.text` holds the rendered string. */
export function textOf(node) {
  const text = node?.properties?.text;
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && typeof text.text === "string") return text.text;
  return null;
}

/** Collects `name -> text` for every labelled node in a subtree dump. */
export function textsInSubtree(tree) {
  const out = [];
  for (const node of tree?.nodes ?? []) {
    const text = textOf(node);
    if (text) {
      out.push({ name: node.name, nodePath: node.nodePath, text });
    }
  }
  return out;
}

/** The label text of one of the dropdown's button rows (its text lives on a `Label` child). */
export function rowLabelText(tree, rowName) {
  const row = nodesNamed(tree, rowName)[0];
  if (!row) return null;
  const prefix = `${row.nodePath}/`;
  for (const node of tree?.nodes ?? []) {
    if (node.name === "Label" && node.nodePath.startsWith(prefix)) {
      return textOf(node);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------------

/**
 * Hovers a node (so NClickableControl focuses it) and clicks its true centre.
 *
 * Returns the click position so callers can record it as evidence. `settleMs` gives the game a frame
 * or two to run the focus tween before the click lands.
 */
export async function hoverAndClick(path, { settleMs = 300, expectHovered = true } = {}) {
  const hover = await sts2(["dev", "scene", "hover", "--path", path, "--settle-ms", String(settleMs)]);
  if (expectHovered) {
    assert(hover?.hovered === true, `hover did not land on ${path}`);
  }
  const position = hover?.hoverPosition;
  assert(position && Number.isFinite(position.x) && Number.isFinite(position.y), `hover returned no position for ${path}`);
  const x = Math.round(position.x);
  const y = Math.round(position.y);
  const click = await sts2(["act", "mouse", "click", "--x", String(x), "--y", String(y)], { mode: "dangerous" });
  assert(click?.accepted === true, `raw click at (${x},${y}) for ${path} was not accepted`);
  return { x, y, hovered: hover?.hovered === true };
}

/** Hover WITHOUT clicking -- used to hold a row's hover-tip pair open while evidence is gathered. */
export async function hoverNode(path, { settleMs = 300, expectHovered = true } = {}) {
  const hover = await sts2(["dev", "scene", "hover", "--path", path, "--settle-ms", String(settleMs)]);
  if (expectHovered) {
    assert(hover?.hovered === true, `hover did not land on ${path}`);
  }
  return { position: hover?.hoverPosition ?? null, hovered: hover?.hovered === true };
}

/** A raw click at explicit canvas coords, with no hover first -- used to prove input is BLOCKED. */
export async function clickAt(x, y) {
  const click = await sts2(["act", "mouse", "click", "--x", String(Math.round(x)), "--y", String(Math.round(y))], { mode: "dangerous" });
  assert(click?.accepted === true, `raw click at (${x},${y}) was not accepted`);
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// fixtures + state
// ---------------------------------------------------------------------------------------------

export async function loadFixture(path) {
  return await sts2(["dev", "fixture", "load", "--path", path]);
}

export async function state() {
  return await sts2(["state"]);
}

export async function lobbyNetGameType() {
  const snapshot = await state();
  return snapshot?.characterSelect?.lobby?.netGameType ?? null;
}

export async function selectedCharacterButtonId() {
  const snapshot = await state();
  return snapshot?.characterSelect?.view?.selectedCharacterButtonId ?? null;
}

/** Polls until `predicate(value)` holds, re-reading through `read`. Returns the final value. */
export async function waitFor(read, predicate, { attempts = 40, intervalMs = 250, what = "condition" } = {}) {
  let value = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await read();
    if (predicate(value)) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new ProbeError(`timed out waiting for ${what}; last value: ${JSON.stringify(value)?.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// screenshots
// ---------------------------------------------------------------------------------------------

/**
 * Captures a screenshot and reports the viewport it was actually taken at.
 *
 * The requested width/height are a REQUEST: the game clamps to its real window (1344x756 on the QA
 * box even when 1920x1080 is asked for), so any pixel region derived from a design-space node rect
 * has to be scaled by the applied viewport. Callers get `scaleX`/`scaleY` for exactly that.
 */
export async function screenshot(outputPath, { width = DESIGN_WIDTH, height = DESIGN_HEIGHT } = {}) {
  const payload = await sts2([
    "dev", "screenshot",
    "--width", String(width),
    "--height", String(height),
    "--output", outputPath
  ]);
  const applied = payload?.appliedViewport ?? { width, height };
  return {
    path: outputPath,
    appliedViewport: applied,
    scaleX: applied.width / DESIGN_WIDTH,
    scaleY: applied.height / DESIGN_HEIGHT
  };
}

/** Maps a design-space rect onto a screenshot's pixel grid. */
export function designRectToPixels(rect, shot) {
  return {
    x: Math.round(rect.x * shot.scaleX),
    y: Math.round(rect.y * shot.scaleY),
    width: Math.round(rect.width * shot.scaleX),
    height: Math.round(rect.height * shot.scaleY)
  };
}

/**
 * Runs an ROI screenshot-diff and returns the ROI diff ratio.
 *
 * Used to assert a region CHANGED, which is the inverse of what screenshot-diff is normally for, so
 * the tolerance is set to 0 and the (expected) "visual_mismatch" failure payload is parsed for its
 * numbers instead of being treated as an error.
 */
export async function roiDiffRatio(baselinePath, actualPath, regionsPath) {
  const outcome = await sts2Tolerant([
    "dev", "screenshot-diff",
    "--baseline", baselinePath,
    "--actual", actualPath,
    "--regions", regionsPath,
    "--required-comparison", "roi",
    "--roi-max-diff-ratio", "0"
  ]);
  const comparison = outcome.value?.comparison ?? outcome.value?.error?.comparison;
  const roi = comparison?.comparisons?.roi;
  assert(roi && Number.isFinite(roi.diffRatio), `screenshot-diff did not report an ROI comparison: ${JSON.stringify(outcome.value)?.slice(0, 500)}`);
  return { diffRatio: roi.diffRatio, diffPixels: roi.diffPixels, comparedPixels: roi.comparedPixels, comparison };
}

// ---------------------------------------------------------------------------------------------
// mirror stream
// ---------------------------------------------------------------------------------------------

/**
 * Connects to the hosted browser server as a passive client and scans the stream --
 * the first scene-delta is a full keyframe -- for any node name matching `CouchCoopQr*`.
 *
 * This is the WS-0 safety assertion: mirror clients drive the host with REAL injected input, so a
 * phone that can SEE the QR button can press it and open a dialog on the host's TV. The producer
 * side (spirectl `spirectl_stream_skip` metadata) must keep the whole subtree off the wire.
 *
 * Sensitivity of this scan was proven by a positive control: relaunching with
 * SPIRECTL_SCENE_WATCH_HONOR_STREAM_SKIP=0 makes all 18 CouchCoopQr* names appear here.
 */
export async function scanMirrorForQrNodes({ durationMs = 6000, origin = process.env.COUCHCOOP_GAME_ORIGIN ?? "ws://127.0.0.1:13337", extraPatterns = [] } = {}) {
  const url = `${origin.replace(/\/$/, "")}/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`;
  assert(typeof WebSocket === "function", "global WebSocket is unavailable -- Node >= 22 required");

  return await new Promise(resolve => {
    const socket = new WebSocket(url);
    const matches = new Set();
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
      resolve({ url, messages, bytes, sawFullKeyframe, fullKeyframeBytes, matches: [...matches], socketError });
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
      // `CouchCoopQr` is the whole injected family; a bare "CouchCoop" also appears in the game's own
      // "Mods loaded: ... CouchCoop" label, which is NOT a leak, so the prefix must stay specific.
      for (const match of data.matchAll(/CouchCoopQr[A-Za-z0-9_]*/g)) {
        matches.add(match[0]);
      }
      // Callers can widen the net beyond node names -- e.g. hover-tip TEXT, which lives on GAME nodes
      // (the tip set parents under the game's own container) and would leak by content, not by name.
      for (const pattern of extraPatterns) {
        for (const match of data.matchAll(pattern)) {
          matches.add(match[0]);
        }
      }
    });

    socket.addEventListener("error", event => {
      socketError = event?.message ?? "websocket error";
      finish();
    });
    socket.addEventListener("close", finish);
  });
}
