#!/usr/bin/env node
// EAGER-SCROLL PROBE (R10 WS-E) — a closed-loop, game-free harness for `frontend/src/mirror/eagerScroll.ts`.
//
// The defect eager scrolling fixes is a LATENCY one, so it cannot be measured against a passive recording: the
// interesting behaviour is what the client does in the ~300ms before the host's answer arrives, and what it does
// when that answer lands. This probe therefore does not replay a stream — it SIMULATES THE HOST:
//
//   * it serves a real map keyframe (taken from a recording) over a real WebSocket;
//   * it accepts upstream `input` messages and models the host's scroll exactly — a wheel tick moves the scroll
//     TARGET by ±40 × the message's `count`, a left-drag adds the motion's RELATIVE Y, and the map container then
//     lerps toward that target at `delta*15` until it snaps in;
//   * every inbound message and every outbound delta is delayed by half the configured RTT, so the client sees a
//     realistic round trip rather than an instant one;
//   * it streams the moved container back as an ordinary incremental `scene-delta`.
//
// What it then measures, in the page, through the REAL input path (dispatched wheel / pointer events on the stage):
//   LOCAL LATENCY  — frames between the wheel event and the map's first visible movement (eager: 1; off: the RTT);
//   RIDE-ALONG     — a quill STROKE's on-screen box moves by the same amount as the map container;
//   SETTLE         — the cosmetic translate returns to "0px" and the streamed offset equals what was asked for;
//   COMPENSATION   — a tap fired immediately after a scroll is SENT at the host's coordinate, not the screen's;
//   COMPOSED-Y OVERSHOOT (R11 WS-S, the SHIP GATE) — see below;
//   ENDPOINT EQUALITY (R19 WP5, the ABSOLUTE-CHANNEL ARM) — see below.
//
// THE EQUALITY ARM (`--authority on`). Scroll authority's claim is not "closer" but EQUAL: the host ends up exactly
// where the client did. That is measurable here and nowhere else, because it needs a host that both models the
// same clamp and answers back. With `--authority on` the simulated host advertises `session.scrollAction`,
// accepts `set-scroll-offset` actions (clamping to the same window its wheel path uses), and replies with an
// `action-result` carrying the clamped value — all through the same half-RTT delay as everything else. The probe
// then drives a TRACKPAD gesture, whose travel is deliberately not a whole multiple of the 80px wheel notch, and
// reports TWO numbers, which are different questions and must not be conflated:
//   * `endpointGapPx` — do the client and the host agree at rest? BOTH paths score 0 here, and that is not a
//     tie: the relative path agrees because the CLIENT GAVE IN (the settle glided its eager offset back onto the
//     host's quantised landing), which is the mechanism, not a virtue.
//   * `gestureShortfallPx` — did the gesture the PLAYER made actually happen? This is the one the round is about.
//     Relative replay scores the quantisation residual (measured: 37.5px of a 277.5px gesture simply never
//     happened, because 277.5 is not a whole number of 80px notches). The absolute channel scores 0: the number
//     the player reached is the number that was sent.
// `steps.absolute` reports both, both endpoints, and — the other half of the claim — WHICH WIRE carried the
// gesture, since the absolute channel REPLACES the tick replay rather than shadowing it.
//
// THE OVERSHOOT GATE. The round-2 feature had TWO rAF writers for one pixel: the renderer wrote the node's baked
// `matrix()` (a fresh host lerp step every reconciled frame) and the eager engine wrote the cosmetic `translate`
// (composed against whatever the matrix said when IT last ran). In the deterministically wrong order every
// reconciled frame therefore painted `eagerY + one host lerp step`, and the map visibly SHOOK. The composed sum
// `matrix.f + translate.y` is exactly the quantity that must not move while the player is not scrolling, so the
// probe samples BOTH halves per animation frame and reports the largest deviation from the value the gesture
// finally rests at (`composed.overshootPx`, design px — the element's own matrix is written in design space).
//   * single-writer composition (WS-S §1): ≤ ~8px — the residual is the settle glide, not a shake;
//   * two-writer (round 2):                ~138px at rtt 250.
//
// THE OFF-SWITCH CONTRACT. `--eager off` must keep the upstream wire byte-identical to the pre-feature client, so
// every upstream `input` message of the whole run is dumped to `wire.json`; two runs of `--eager off` across a code
// change must produce the same file.
//
// Usage:
//   node scripts/probe-eager-scroll.mjs                      # eager ON, 250ms RTT
//   node scripts/probe-eager-scroll.mjs --eager off          # the `?eagerScroll=off` A/B (today's behaviour)
//   node scripts/probe-eager-scroll.mjs --rtt 400 --out .sts2/artifacts/eager-scroll-slow
//   node scripts/probe-eager-scroll.mjs --assets http://127.0.0.1:13337   # real textures in the screenshots
//   node scripts/probe-eager-scroll.mjs --tool armed                # the map with a DRAWING TOOL armed (§7)
//   node scripts/probe-eager-scroll.mjs --authority on              # R19 WP5: the ABSOLUTE channel (the A/B pair
//   node scripts/probe-eager-scroll.mjs --authority off             #   is these two runs, same everything else)
//   node scripts/probe-eager-scroll.mjs --scrollable grid \
//     --recording .sts2/bench/wscrisp-deckdialog.ndjson                    # the deck-view CARD GRID instead
//   node scripts/probe-eager-scroll.mjs --stage canvas             # M3 WS-D: the SINGLE-CANVAS stage's own arm
//
// THE CANVAS ARM (`--stage canvas`). Same gestures, same numbers, read from `window.__mirrorScrollProbe` instead
// of from the container's element — that stage has none. It adds `steps.builds`, because an offset write costs a
// whole draw-list rebuild there and nothing on the DOM path, and it FAILS rather than defaults when the seam is
// missing: this probe was element-bound throughout, so pointing it at the canvas stage without a seam would have
// found no element, measured nothing, and reported a green run with `firstMotionMs: null`.
//
// Artifacts land under `--out` (default `.sts2/artifacts/eager-scroll/`): `result.json` plus `01-rest.png`,
// `02-just-after-wheel.png`, `03-settled.png`. NOTE: the map's textures come from the GAME's asset routes, which
// this probe does not have — without `--assets <live game origin>` the screenshots show the HUD text over an empty
// stage and the geometry numbers in `result.json` are the real evidence. Point `--assets` at a running host to get
// pictures worth looking at.

import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireReproHeader } from "./lib/repro-recording.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ==============================================================================================================
// args
// ==============================================================================================================

function parseArgs(argv) {
  const a = {
    recording: ".sts2/bench/probe-map-visible.ndjson",
    scrollable: "map",
    port: 13412,
    rtt: 250,
    eager: "on",
    out: ".sts2/artifacts/eager-scroll",
    devPort: 5199,
    assets: null,
    keep: false,
    trace: false,
    tool: "away",
    // R19 WP5: does the simulated host offer the ABSOLUTE channel? "off" is the pre-round host exactly (no
    // capability on the session, no action handler), which is what makes the two runs a clean A/B.
    authority: "off",
    // M3 WS-D: which STAGE is under the probe. "dom" reads the container's element (its baked `matrix()` and its
    // cosmetic `translate`); "canvas" reads the same two numbers off `window.__mirrorScrollProbe`, because that
    // stage paints into one canvas and has no element to read. See `canvasReader`.
    stage: "dom"
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--recording") a.recording = next();
    else if (arg === "--scrollable") a.scrollable = next();
    else if (arg === "--port") a.port = Number(next());
    else if (arg === "--rtt") a.rtt = Number(next());
    else if (arg === "--eager") a.eager = next();
    else if (arg === "--out") a.out = next();
    else if (arg === "--dev-port") a.devPort = Number(next());
    else if (arg === "--assets") a.assets = next();
    else if (arg === "--keep") a.keep = true;
    else if (arg === "--trace") a.trace = true;
    else if (arg === "--tool") a.tool = next();
    else if (arg === "--authority") a.authority = next();
    else if (arg === "--stage") a.stage = next();
    else throw new Error(`unknown arg ${arg}`);
  }
  if (a.stage !== "dom" && a.stage !== "canvas") {
    throw new Error(`--stage must be dom|canvas (got ${a.stage})`);
  }
  return a;
}

// ==============================================================================================================
// a minimal RFC6455 text-frame server (the repo has no `ws` dependency; same approach as replay-ws-server.mjs)
// ==============================================================================================================

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

// Incremental frame reader: enough of RFC6455 for a browser client (masked text frames + close/ping).
function makeReader(onText, onClose) {
  let buf = Buffer.alloc(0);
  const parts = [];
  let fragOp = null;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = buf.subarray(offset, offset + len);
      if (mask) {
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) {
        onClose();
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) continue;
      if (opcode === 0x0) {
        parts.push(payload);
        if (fin) {
          onText(Buffer.concat(parts).toString("utf8"));
          parts.length = 0;
          fragOp = null;
        }
        continue;
      }
      if (!fin) {
        fragOp = opcode;
        parts.length = 0;
        parts.push(payload);
        continue;
      }
      onText(payload.toString("utf8"));
    }
  };
}

// ==============================================================================================================
// the recorded map keyframe
// ==============================================================================================================

// Pull the LAST full keyframe out of a recording, plus the id of the container the probe will scroll: `TheMap`
// under an `NMapScreen` (the map) or `ScrollContainer` under an `NCardGrid` (a deck/draw/discard/exhaust grid).
// These are exactly the two the renderer's `eagerScrollTargets` recognises.
function loadMapKeyframe(path, scrollable) {
  const recordingText = readFileSync(path, "utf8");
  requireReproHeader(recordingText, path);
  const lines = recordingText.split("\n").filter(Boolean);
  let keyframe = null;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.data) continue;
    let msg;
    try {
      msg = JSON.parse(rec.data);
    } catch {
      continue;
    }
    if (msg.type === "scene-delta" && msg.full === true) keyframe = msg;
  }
  if (!keyframe) throw new Error(`no full keyframe in ${path}`);

  const wantName = scrollable === "grid" ? "ScrollContainer" : "TheMap";
  const wantParent = scrollable === "grid" ? "NCardGrid" : "NMapScreen";
  const byId = new Map();
  for (const u of keyframe.upserts ?? []) byId.set(u.id, u);
  let mapId = null;
  for (const u of keyframe.upserts ?? []) {
    if (u.name !== wantName || u.parentId == null) continue;
    const parent = byId.get(u.parentId);
    if (parent && String(parent.nodeType ?? "").endsWith(wantParent)) {
      mapId = u.id;
      break;
    }
  }
  if (!mapId) throw new Error(`no ${wantName}/${wantParent} container in ${path}`);
  const mapNode = byId.get(mapId);
  return {
    keyframe,
    mapId,
    mapNode,
    grid: scrollable === "grid" ? synthesizeDeck(keyframe, byId, mapNode) : null
  };
}

// A RECYCLED GRID, synthesized from the recorded one (R11 WS-S). The deck in the recording is barely taller than
// its own frame, so nothing about it is virtualized and the client's materialized-band logic never engages. Here the
// recorded holders are re-laid into a bounded window of rows over a much taller content rect, which is exactly the
// shape `NCardGrid` streams for a real deck: a pool of `DisplayedRows` rows that the host RECYCLES
// (AllocateCardHolders → ReallocateAbove/Below) as the offset moves, over content sized to the whole collection.
const SYNTH_CONTENT_H = 3000; // ScrollContainer.Size.Y — about a 40-card deck
const SYNTH_ROW_PITCH = 377.6; // the recorded pitch between card rows
const SYNTH_FIRST_ROW_Y = 348.8; // the recorded first-row local Y (below the SortingOptions header)

function synthesizeDeck(keyframe, byId, container) {
  const holders = (keyframe.upserts ?? []).filter(
    (u) => u.parentId === container.id && String(u.nodeType ?? "").endsWith("NGridCardHolder")
  );
  if (holders.length === 0) throw new Error("no NGridCardHolder rows in the grid keyframe");
  const owner = byId.get(container.parentId);
  const xs = [...new Set(holders.map((h) => h.transform?.origin?.x ?? 0))].sort((a, b) => a - b);
  const cols = Math.max(1, xs.length);
  // Re-lay the pool row-major, and grow the content rect so there is far more deck than pool.
  const rows = [];
  holders.forEach((h, i) => {
    const row = Math.floor(i / cols);
    const y = SYNTH_FIRST_ROW_Y + row * SYNTH_ROW_PITCH;
    h.transform = { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: xs[i % cols], y } };
    if (!rows[row]) rows[row] = { y, ids: [] };
    rows[row].ids.push(h.id);
  });
  container.localRect = { position: { x: 0, y: 0 }, size: { x: container.localRect?.size?.x ?? 1570, y: SYNTH_CONTENT_H } };
  return {
    rows,
    cols,
    xs,
    ownerId: owner?.id ?? null,
    // The grid frame's own top in game space, which the recycler measures its rows' GLOBAL y against.
    ownerY: owner?.transform?.origin?.y ?? 80,
    ownerH: owner?.localRect?.size?.y ?? 1002,
    contentH: SYNTH_CONTENT_H,
    // The last row the collection actually has — the recycler may not invent rows past it.
    lastRowY: SYNTH_FIRST_ROW_Y + Math.floor((SYNTH_CONTENT_H - SYNTH_FIRST_ROW_Y) / SYNTH_ROW_PITCH - 1) * SYNTH_ROW_PITCH
  };
}

// ==============================================================================================================
// the simulated host
// ==============================================================================================================

// The map's scroll numbers, matched to what the host actually does: ±40 per wheel edge, lerp `delta*15`, snap
// under 0.5, window [-600,1800]. EDGES_PER_TICK is the trap live QA found: the host counts a wheel PRESS and its
// RELEASE alike, and spirectl injects a wheel tick as a FULL CLICK, so both edges add their 40 — one tick on this
// wire moves the map 80. The client's WHEEL_NOTCH_PX carries the same number.
const NOTCH = 40;
const EDGES_PER_TICK = 2;
const LERP_SPEED = 15;
const SNAP = 0.5;
// The MAP's own window; a card grid instead travels `viewport − content .. 0`, which startHost derives from the
// keyframe rects.
const LIMIT_LO = -600;
const LIMIT_HI = 1800;

function startHost({ port, rtt, keyframe, mapId, mapNode, grid, assets, log, authority }) {
  const half = Math.max(0, rtt / 2);
  const originX = mapNode.transform?.origin?.x ?? 0;
  // A card grid travels `frame − content .. 0` (its own scroll window) instead of the map's.
  const limitLo = grid ? grid.ownerH - grid.contentH : LIMIT_LO;
  const limitHi = grid ? 0 : LIMIT_HI;
  const state = {
    // The container position + the drag target the game lerps toward.
    position: mapNode.transform?.origin?.y ?? -600,
    target: mapNode.transform?.origin?.y ?? -600,
    lastMotionY: null,
    dragging: false,
    inputs: [],
    // R19 WP5: the absolute sends this host accepted, in order — `{ elementId, requested, clamped }`.
    actions: [],
    conn: null
  };

  const send = (obj) => {
    const payload = JSON.stringify(obj);
    setTimeout(() => state.conn?.write(encodeFrame(payload)), half);
  };

  // The host's own row RECYCLER, as the wire shows it: whenever the pool's top row has slid below the screen top,
  // the BOTTOM row re-appears above it, and vice versa — a bounded pool sliding over unbounded content. Returns
  // the holders whose position changed, for the delta.
  function recycle() {
    if (!grid) return [];
    const moved = [];
    for (let guard = 0; guard < 8; guard++) {
      grid.rows.sort((a, b) => a.y - b.y);
      const first = grid.rows[0];
      const last = grid.rows[grid.rows.length - 1];
      const globalOf = (row) => grid.ownerY + state.position + row.y;
      if (globalOf(first) > 0 && first.y - SYNTH_ROW_PITCH >= SYNTH_FIRST_ROW_Y) {
        last.y = first.y - SYNTH_ROW_PITCH;
        moved.push(last);
        continue;
      }
      if (globalOf(last) < 1080 && last.y + SYNTH_ROW_PITCH <= grid.lastRowY) {
        first.y = last.y + SYNTH_ROW_PITCH;
        moved.push(first);
        continue;
      }
      break;
    }
    return moved.flatMap((row) =>
      row.ids.map((id, col) => ({
        id,
        parentId: mapId,
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: grid.xs[col % grid.cols], y: row.y } },
        localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
        visible: true
      }))
    );
  }

  function sendMapDelta() {
    send({
      type: "scene-delta",
      full: false,
      screenType: keyframe.screenType,
      screenInstanceId: keyframe.screenInstanceId,
      upserts: [
        {
          id: mapId,
          parentId: mapNode.parentId,
          // Only Y scrolls — the container's own X (a card grid sits at x=175 inside its screen) must ride through
          // untouched, or the probe would shift the whole grid sideways and every screenshot with it.
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: originX, y: state.position } },
          localRect: mapNode.localRect,
          visible: true
        },
        ...recycle()
      ],
      removedIds: []
    });
  }

  // The host's own per-frame settle: lerp toward the target, snap when close, elastically pull the target back
  // inside the scroll window when nothing is dragging.
  const tick = setInterval(() => {
    const dt = 1 / 60;
    let moved = false;
    if (Math.abs(state.position - state.target) > 0.01) {
      state.position += (state.target - state.position) * Math.min(1, dt * LERP_SPEED);
      if (Math.abs(state.position - state.target) < SNAP) state.position = state.target;
      moved = true;
    }
    if (!state.dragging) {
      if (state.target < limitLo) state.target += (limitLo - state.target) * Math.min(1, dt * 12);
      else if (state.target > limitHi) state.target += (limitHi - state.target) * Math.min(1, dt * 12);
    }
    if (moved) sendMapDelta();
  }, 1000 / 60);

  // R19 WP5 — `set-scroll-offset`, modelled the way Sts2ActionHandler.Scroll does it: resolve the addressed
  // container, clamp the wanted offset to the SURFACE's own window, write the scroll target, and answer with BOTH
  // the clamped and the requested value. The reply travels back through the same half-RTT as everything else, so
  // the client's ack arrives when a real one would.
  function handleAction(msg) {
    if (msg.semanticActionId !== "set-scroll-offset") {
      return;
    }
    const elementId = String(msg.args?.elementId ?? "");
    const requested = Number(msg.args?.offsetY);
    if (elementId !== String(mapId) || !Number.isFinite(requested)) {
      // The handler refuses an id that is not the surface's own scroll container; so does this.
      send({ type: "action-result", requestId: msg.requestId, semanticActionId: msg.semanticActionId, code: "stale-id" });
      return;
    }
    const lo = Math.min(limitLo, limitHi);
    const hi = Math.max(limitLo, limitHi);
    const clamped = requested < lo ? lo : requested > hi ? hi : requested;
    state.target = clamped;
    state.actions.push({ at: Date.now(), elementId, requested, clamped });
    send({
      type: "action-result",
      requestId: msg.requestId,
      semanticActionId: msg.semanticActionId,
      result: {
        success: true,
        result: {
          accepted: true,
          actionInstanceId: `action:set-scroll-offset:${msg.requestId}`,
          message: "ok",
          provisional: false,
          // Values are a C# Dictionary<string,string>: every number reaches the browser as a STRING.
          values: { offsetY: String(clamped), requestedY: String(requested), surface: grid ? "grid" : "map" }
        }
      }
    });
  }

  function handleInput(msg) {
    state.inputs.push({ at: Date.now(), msg });
    if (msg.kind === "click" && (msg.button === "wheel-up" || msg.button === "wheel-down")) {
      const count = Number.isFinite(msg.count) ? Math.min(20, Math.max(1, msg.count)) : 1;
      state.target += (msg.button === "wheel-up" ? NOTCH : -NOTCH) * EDGES_PER_TICK * count;
      return;
    }
    if (msg.kind === "click" && msg.button === "left") {
      if (msg.pressed === true) {
        state.dragging = true;
        state.target = state.position;
        state.lastMotionY = msg.coordY;
      } else if (msg.pressed === false) {
        state.dragging = false;
        state.lastMotionY = msg.coordY;
      }
      return;
    }
    if (msg.kind === "hover") {
      // Godot derives `Relative` from consecutive injected positions; the map adds it to its drag target.
      if (state.dragging && state.lastMotionY != null) {
        state.target += msg.coordY - state.lastMotionY;
      }
      state.lastMotionY = msg.coordY;
    }
  }

  // Everything that is NOT the WebSocket is an ASSET route (`/res`, `/models`, `/spines`, `/catalog`) the dev
  // server proxies here along with `/ws`. This probe has no assets of its own, so with `--assets <origin>` they are
  // relayed to a running host (which is what makes the screenshots show a real map) and 404'd otherwise.
  const server = createServer((req, res) => {
    if (!assets) {
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = new URL(req.url, assets);
    const proxied = httpRequest(
      { hostname: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search, method: req.method },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    proxied.on("error", () => {
      if (!res.writableEnded) {
        res.writeHead(502);
        res.end();
      }
    });
    req.pipe(proxied);
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    state.conn = socket;
    const read = makeReader(
      (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === "ping") {
          send({ type: "pong", t0: msg.t0, mainThread: msg.mainThread });
          return;
        }
        if (msg.type === "join") {
          send({ type: "session", requestId: msg.requestId, directView: true, scrollAction: authority });
          return;
        }
        if (msg.type === "input") setTimeout(() => handleInput(msg), half);
        // R19 WP5: an absolute scroll send. Gated on the capability this host advertised, so an `--authority off`
        // run really is the pre-round host — it would answer "not a supported action kind" if it ever saw one.
        if (msg.type === "action" && authority) setTimeout(() => handleAction(msg), half);
      },
      () => {
        state.conn = null;
      }
    );
    socket.on("data", read);
    socket.on("close", () => {
      state.conn = null;
    });
    socket.on("error", () => {
      state.conn = null;
    });

    // A directView session (the recording is passive, so it carries none) then the keyframe. `scrollAction` is the
    // R19 WP5 capability the client gates its whole authority path on — false here IS an older host.
    send({ type: "session", requestId: "session", directView: true, scrollAction: authority });
    send(keyframe);
    if (log) console.log(`[probe-eager] client connected; map=${mapId} at y=${state.position}`);
  });

  server.listen(port, "127.0.0.1");
  return {
    state,
    stop() {
      clearInterval(tick);
      server.close();
      try {
        state.conn?.destroy();
      } catch {
        /* closing */
      }
    }
  };
}

// ==============================================================================================================
// the composed-Y overshoot metric (the ship gate)
// ==============================================================================================================

// `trace` is the in-page rAF sampler's output. The measurement window opens SETTLE_LEAD_MS after the wheel burst
// was dispatched (by then every notch is in and the eager offset is at its final value) and runs to the end of the
// trace; the reference is the LAST sampled composed value, i.e. where the gesture actually came to rest.
const OVERSHOOT_LEAD_MS = 60;

function composedOvershoot(trace) {
  const usable = trace.samples.filter((s) => s.composedY !== null);
  if (usable.length === 0) {
    return { overshootPx: null, note: "no matrix() on the container — nothing to compose" };
  }
  const window = usable.filter((s) => s.t >= trace.dispatchAt + OVERSHOOT_LEAD_MS);
  if (window.length < 2) {
    return { overshootPx: null, note: "measurement window too short" };
  }
  const rest = window[window.length - 1].composedY;
  let overshoot = 0;
  let atMs = null;
  let maxStep = 0;
  for (let i = 0; i < window.length; i++) {
    const dev = Math.abs(window[i].composedY - rest);
    if (dev > overshoot) {
      overshoot = dev;
      atMs = Math.round(window[i].t - trace.dispatchAt);
    }
    if (i > 0) {
      const step = Math.abs(window[i].composedY - window[i - 1].composedY);
      if (step > maxStep) maxStep = step;
    }
  }
  return {
    // Design px: the container's own matrix is written in design space, and the cosmetic translate alongside it.
    overshootPx: Number(overshoot.toFixed(2)),
    // The biggest single-FRAME jump of the composed position inside the window — the shake's own signature (a
    // two-writer frame moves by a whole host lerp step and back).
    maxFrameStepPx: Number(maxStep.toFixed(2)),
    atMsAfterWheel: atMs,
    restComposedY: Number(rest.toFixed(2)),
    samples: window.length,
    // The base matrix DOES keep stepping while the host catches up — that is the host's lerp, and seeing it move
    // while the composed sum does not is the whole point of the single-writer invariant.
    baseTravelPx: Number(Math.abs(window[window.length - 1].baseY - window[0].baseY).toFixed(2))
  };
}

// M3 WS-D (canvas arm) — DRAW-LIST BUILDS PER GESTURE FRAME.
//
// The window is the same one the overshoot gate uses, from the wheel burst to the end of the trace, but the
// question is the opposite one: not "did the picture hold still" but "what did holding it still cost". Per frame
// it reports the total builds and the subset an OFFSET caused, plus the writes that were folded into an existing
// build instead of buying one. A frame that pays for the compose seam's write AND the engine's own scores 2
// offset builds; the coalesced target is 1.
function buildsPerGestureFrame(trace) {
  const usable = trace.samples.filter((s) => typeof s.builds === "number");
  const window = usable.filter((s) => s.t >= trace.dispatchAt);
  if (window.length < 3) {
    return { note: "no build counters in the trace — is this the canvas arm?" };
  }
  const perFrame = [];
  const perFrameOffset = [];
  for (let i = 1; i < window.length; i++) {
    perFrame.push(window[i].builds - window[i - 1].builds);
    perFrameOffset.push(window[i].offsetBuilds - window[i - 1].offsetBuilds);
  }
  // Only the frames that did SOMETHING: a settled tail of idle frames would drag every average to zero and hide
  // exactly the frames the metric is about.
  const busy = perFrame.map((v, i) => ({ builds: v, offset: perFrameOffset[i] })).filter((f) => f.builds > 0);
  const median = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[xs.length >> 1]);
  return {
    gestureFrames: perFrame.length,
    busyFrames: busy.length,
    buildsPerBusyFrameP50: median(busy.map((f) => f.builds)),
    buildsPerBusyFrameMax: busy.length === 0 ? null : Math.max(...busy.map((f) => f.builds)),
    offsetBuildsPerBusyFrameP50: median(busy.map((f) => f.offset)),
    offsetBuildsPerBusyFrameMax: busy.length === 0 ? null : Math.max(...busy.map((f) => f.offset)),
    totalBuilds: window[window.length - 1].builds - window[0].builds,
    totalOffsetBuilds: window[window.length - 1].offsetBuilds - window[0].offsetBuilds,
    // Writes that rode a build somebody else was already paying for — the coalescer's own output.
    totalOffsetCoalesced: window[window.length - 1].offsetCoalesced - window[0].offsetCoalesced
  };
}

// ==============================================================================================================
// main
// ==============================================================================================================

// The container's COMPOSED position as the browser paints it: the walk's baked `matrix()` translation plus the
// eager engine's cosmetic `translate` (CSS applies the two in that order). This is the only honest reading of
// "where is the client showing this content", and the quantity R19 WP5's equality arm compares against the host's.
async function readComposed(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { composedY: Number.NaN, baseY: Number.NaN, translate: "" };
    const transform = el.style.transform || "";
    const open = transform.indexOf("matrix(");
    const close = open < 0 ? -1 : transform.indexOf(")", open);
    const parts = close < 0 ? [] : transform.slice(open + 7, close).split(",");
    const baseY = parts.length === 6 ? Number(parts[5]) : Number.NaN;
    const translate = el.style.translate || "";
    const bits = translate.trim().split(/\s+/);
    const dy = bits.length > 1 ? parseFloat(bits[1]) : 0;
    return { composedY: baseY + (Number.isFinite(dy) ? dy : 0), baseY, translate };
  }, sel);
}

// ==============================================================================================================
// the CANVAS arm's reader (M3 WS-D)
// ==============================================================================================================
//
// `?stage=canvas` paints the whole scene into ONE canvas: the scroll container has no element, so every reading
// above is unavailable — and that is the trap this arm is built around. The probe was element-bound throughout,
// so pointing it at the canvas stage without this would have found no element, measured nothing, and reported a
// green run with `firstMotionMs: null`. Every canvas reading therefore goes through `window.__mirrorScrollProbe`
// (canvasRenderer.scrollProbe), and its ABSENCE IS A HARD FAILURE, never a default.
//
// The two numbers are the same two: `baseY` is what the build baked (the DOM's `matrix().f`) and `offsetY` is the
// cosmetic offset composed on top of it (the DOM's `translate`), both in design px — which is the space the DOM
// arm's matrix is written in too, so the composed-overshoot gate compares like with like across the arms.
// `globalY` stands in for `getBoundingClientRect().top`: it is where the container's origin lands on the stage,
// in design rather than CSS px (the two differ by the letterbox scale, so the TRAVEL numbers are not comparable
// across arms — the latency and overshoot ones are).

async function readCanvasProbe(page, nodeId) {
  const probe = await page.evaluate((id) => {
    const fn = window.__mirrorScrollProbe;
    return typeof fn === "function" ? fn(id) : null;
  }, nodeId);
  if (!probe) {
    throw new Error("__mirrorScrollProbe is gone — the canvas arm has nothing to measure (see canvasRenderer.scrollProbe)");
  }
  return probe;
}

// The canvas twin of `readMap`, in the same shape so every consumer below is arm-agnostic.
async function readCanvasMap(page, nodeId) {
  const probe = await readCanvasProbe(page, nodeId);
  return {
    translate: probe.offsetY === 0 ? "0px" : `0px ${probe.offsetY.toFixed(2)}px`,
    transform: probe.baseY === null ? "" : `matrix(1, 0, 0, 1, 0, ${probe.baseY})`,
    top: probe.globalY,
    kidId: null,
    kidTop: null,
    targets: probe.targets,
    offsetBuilds: probe.offsetBuilds,
    offsetCoalesced: probe.offsetCoalesced,
    builds: probe.builds
  };
}

async function readCanvasComposed(page, nodeId) {
  const probe = await readCanvasProbe(page, nodeId);
  return {
    composedY: probe.composedY,
    baseY: probe.baseY,
    translate: probe.offsetY === 0 ? "0px" : `0px ${probe.offsetY.toFixed(2)}px`
  };
}

// THE FRAME PUMP, and why the canvas arm cannot be measured without one.
//
// A HEADLESS Chromium produces compositor frames on DAMAGE, and `rAF` callbacks ride those frames. The DOM arm is
// never short of damage (the map screen's own CSS animations repaint something every frame), but the canvas stage
// PARKS: between builds its canvas is unchanged, nothing is damaged, and the frame interval backs off — measured
// here at 126ms → 248ms → 533ms → 716ms after a single gesture. That starves BOTH the probe's sampler (11 samples
// in 1400ms, so "one frame of latency" cannot even be expressed) and the eager engine's own settle loop, whose
// deadlines are wall-clock and fire while it is not being called.
//
// On a real display that never happens — the compositor ticks at vsync whether or not anyone damaged anything, so
// a parked stage still gets its rAF. The pump restores that property, and only that: it moves one off-screen 1px
// marker per frame. Nothing it touches is read by any measurement below (every canvas reading comes from the
// renderer's own state through `__mirrorScrollProbe`).
async function startFramePump(page) {
  await page.evaluate(() => {
    // IN the viewport on purpose: an off-screen element's change damages nothing, which is exactly the state
    // being escaped. One pixel in the top-left corner, alternating between two near-transparent blacks.
    const marker = document.createElement("div");
    marker.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;background:#000";
    document.body.appendChild(marker);
    let i = 0;
    const tick = () => {
      marker.style.opacity = i++ % 2 ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// THE ENTRY GATE. Runs before anything is measured: the seam must exist AND report a live scroll target, or the
// run stops here with a message that says which of the two failed.
async function requireCanvasSeam(page, nodeId) {
  const handle = await page
    .waitForFunction(
      (id) => {
        const fn = window.__mirrorScrollProbe;
        if (typeof fn !== "function") return null;
        const probe = fn(id);
        return probe && probe.targets > 0 && probe.baseY !== null ? probe : null;
      },
      nodeId,
      { timeout: 20000, polling: 250 }
    )
    .catch(() => null);
  if (!handle) {
    const seen = await page.evaluate((id) => {
      const fn = window.__mirrorScrollProbe;
      return typeof fn !== "function" ? { seam: false } : { seam: true, probe: fn(id) };
    }, nodeId);
    throw new Error(
      `--stage canvas: the scroll probe never went live (${JSON.stringify(seen)}). ` +
        "Either the stage is not the canvas one (check ?stage=canvas reached the page), the paint-dump gate is " +
        "closed (add ?paintDump=1 on a built bundle), or eagerScrollTargets found no scrollable in this recording."
    );
  }
  return handle.jsonValue();
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = resolve(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const recording = resolve(REPO_ROOT, args.recording);
  if (!existsSync(recording)) throw new Error(`recording not found: ${recording}`);

  const { keyframe, mapId, mapNode, grid } = loadMapKeyframe(recording, args.scrollable);
  // §7 — ARM A DRAWING TOOL. The armed state is published by the tool button's Icon texture (the `*_glow` variant,
  // mirrorRenderer.mapDrawingToolActive), so arming it in a recorded keyframe is a one-field rewrite; the client
  // then sees exactly what it would see if the player had tapped the quill.
  let armedIcons = 0;
  if (args.tool === "armed") {
    for (const u of keyframe.upserts ?? []) {
      const path = u.texture?.resourcePath;
      if (typeof path === "string" && path.endsWith("drawing_quill.png")) {
        u.texture = { ...u.texture, resourcePath: path.replace("drawing_quill.png", "drawing_quill_glow.png") };
        armedIcons++;
      }
    }
    if (armedIcons === 0) throw new Error("no drawing_quill.png icon in the keyframe to arm");
  }
  const host = startHost({
    port: args.port,
    rtt: args.rtt,
    keyframe,
    mapId,
    mapNode,
    grid,
    assets: args.assets,
    log: true,
    authority: args.authority === "on"
  });

  const { chromium } = await import(join(REPO_ROOT, "frontend/node_modules/@playwright/test/index.mjs"));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[page-error] ${m.text()}`);
  });

  const canvasArm = args.stage === "canvas";
  const query = new URLSearchParams({ name: "" });
  if (args.eager === "off") query.set("eagerScroll", "off");
  if (canvasArm) {
    query.set("stage", "canvas");
    // The probe seam rides the paint-dump gate, which a dev build opens on its own; asked for explicitly so the
    // same command also works against a built bundle.
    query.set("paintDump", "1");
  }
  const url = `http://127.0.0.1:${args.devPort}/?${query.toString()}`;

  const result = {
    eager: args.eager,
    authority: args.authority,
    stage: args.stage,
    scrollable: args.scrollable,
    tool: args.tool,
    rttMs: args.rtt,
    mapId,
    url,
    steps: {}
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // The page derives its WS from `location`, so the dev server must proxy /ws to this probe (see the runner).
    if (canvasArm) {
      // FAIL HARD, do not default: see `requireCanvasSeam`.
      result.canvasSeam = await requireCanvasSeam(page, mapId);
      await startFramePump(page); // …and see `startFramePump` for why a parked stage needs one here
    } else {
      await page.waitForSelector(`[data-node-id="${mapId}"]`, { timeout: 20000 });
    }
    await page.waitForTimeout(1500);

    const mapSel = `[data-node-id="${mapId}"]`;
    const readMap = async () =>
      canvasArm
        ? readCanvasMap(page, mapId)
        : page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const box = el.getBoundingClientRect();
            // A quill stroke / any descendant that must ride the same translate.
            const kid = el.querySelector("[data-node-id]");
            const kidBox = kid ? kid.getBoundingClientRect() : null;
            return {
              translate: el.style.translate || "",
              transform: el.style.transform || "",
              top: box.top,
              kidId: kid ? kid.getAttribute("data-node-id") : null,
              kidTop: kidBox ? kidBox.top : null
            };
          }, mapSel);

    result.steps.rest = await readMap();
    await page.screenshot({ path: join(outDir, "01-rest.png") });

    // --- WHEEL: five notches down, with an in-page frame recorder ---------------------------------------------
    // THE headline measurement. A rAF loop samples the map's on-screen position for a second around the gesture, so
    // "how long until the content moved" is read off the real compositor rather than inferred from a CDP round
    // trip: `firstMotionMs` is the time from the wheel event to the first frame whose paint differs.
    const before = host.state.position;
    const beforeInputs = host.state.inputs.length;
    const trace = await page.evaluate(
      ({ sel, ms, canvas, nodeId }) =>
        new Promise((done) => {
          const el = canvas ? null : document.querySelector(sel);
          const stage = document.querySelector(".mirror-stage") ?? document.body;
          const samples = [];
          const t0 = performance.now();
          let dispatched = false;
          let dispatchAt = 0;
          // The two halves of the composed position, read off the SAME frame: the renderer's baked matrix and the
          // eager engine's cosmetic translate. Their sum is what the player sees (CSS applies `translate` outside
          // `transform`), and it is the quantity the single-writer invariant pins.
          const matrixY = (value) => {
            const open = value.indexOf("matrix(");
            if (open < 0) return null;
            const close = value.indexOf(")", open);
            if (close < 0) return null;
            const parts = value.slice(open + 7, close).split(",");
            return parts.length === 6 ? Number(parts[5]) : null;
          };
          const translateY = (value) => {
            if (!value) return 0;
            const parts = value.trim().split(/\s+/);
            const y = parts.length > 1 ? parseFloat(parts[1]) : 0;
            return Number.isFinite(y) ? y : 0;
          };
          // ONE FRAME's reading, from whichever stage is under the probe. The canvas arm asks the renderer for the
          // same two numbers (design px, so the composed metrics are comparable) plus its build counters, which
          // only exist on that side — the DOM path's offset write is a style assignment and costs no build.
          const readFrame = () => {
            if (canvas) {
              const probe = window.__mirrorScrollProbe(nodeId);
              return {
                top: probe.globalY,
                translate: probe.offsetY === 0 ? "0px" : `0px ${probe.offsetY.toFixed(2)}px`,
                baseY: probe.baseY,
                composedY: probe.composedY,
                builds: probe.builds,
                offsetBuilds: probe.offsetBuilds,
                offsetCoalesced: probe.offsetCoalesced
              };
            }
            const transform = el.style.transform || "";
            const translate = el.style.translate || "";
            const base = matrixY(transform);
            return {
              top: el.getBoundingClientRect().top,
              translate,
              baseY: base,
              composedY: base === null ? null : base + translateY(translate)
            };
          };
          const baseline = readFrame().top;
          const step = () => {
            const now = performance.now();
            samples.push({ t: now - t0, ...readFrame() });
            if (!dispatched && now - t0 >= 100) {
              dispatched = true;
              dispatchAt = now - t0;
              for (let i = 0; i < 5; i++) {
                stage.dispatchEvent(
                  new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, clientX: 640, clientY: 360, bubbles: true, cancelable: true })
                );
              }
            }
            if (now - t0 < ms) requestAnimationFrame(step);
            else done({ baseline, dispatchAt, samples });
          };
          requestAnimationFrame(step);
        }),
      // The window has to OUTLIVE the settle, because the overshoot metric's reference is the LAST sample: a trace
      // that stops mid-catch-up measures where it stopped rather than where the gesture rested. 1400ms is enough
      // on the DOM arm (kept, so its numbers stay comparable across rounds); the canvas arm samples far more
      // sparsely on this harness — a headless software rasteriser runs the map screen at a few frames a second
      // while it scrolls — so it gets a window sized to the round trip it is waiting on.
      { sel: mapSel, ms: canvasArm ? Math.max(1400, args.rtt * 4 + 1400) : 1400, canvas: canvasArm, nodeId: mapId }
    );
    const moved = trace.samples.find((s) => s.t > trace.dispatchAt && Math.abs(s.top - trace.baseline) > 1);
    // The page's own frame cadence, so `firstMotionMs` can be read in FRAMES: a headless Chromium rendering a
    // 3000-node scene without a GPU runs nowhere near 60fps, and "one frame" is the only latency claim that means
    // the same thing on this machine and on a phone.
    const intervals = trace.samples.slice(1).map((s, i) => s.t - trace.samples[i].t).sort((a, b) => a - b);
    result.steps.wheel = {
      medianFrameMs: intervals.length ? Math.round(intervals[Math.floor(intervals.length / 2)]) : null,
      dispatchAtMs: Math.round(trace.dispatchAt),
      firstMotionMs: moved ? Math.round(moved.t - trace.dispatchAt) : null,
      firstMotionPx: moved ? Math.round(moved.top - trace.baseline) : null,
      // How far the map had travelled 100ms after the wheel — with eager on this is the FULL 5 notches, with it off
      // the host's answer has not even arrived yet.
      pxAt100ms: (() => {
        const s = trace.samples.find((x) => x.t >= trace.dispatchAt + 100);
        return s ? Math.round(s.top - trace.baseline) : null;
      })(),
      totalPx: Math.round(trace.samples[trace.samples.length - 1].top - trace.baseline),
      hostPositionBefore: before
    };
    // THE SHIP GATE (see the header): how far the COMPOSED position (baked matrix + cosmetic translate) wanders
    // after the eager jump has landed, measured against the value the gesture finally rests at. A settle glide
    // shows up here as a few px; two rAF writers fighting show up as a whole host lerp step.
    result.steps.composed = composedOvershoot(trace);
    // M3 WS-D, canvas only: WHAT THE LEAD COSTS. Every offset write on this stage is a full draw-list rebuild, so
    // the number that matters is builds per GESTURE FRAME — the frames between the wheel burst and the settle,
    // which are the ones paying for both the compose seam's write and the engine's own. `offsetBuilds` counts the
    // builds an offset caused and `offsetCoalesced` the writes that rode one instead.
    if (canvasArm) {
      result.steps.builds = buildsPerGestureFrame(trace);
    }
    // The per-frame sample array behind that number, for when it is not the number you expected (`--trace`).
    if (args.trace) {
      writeFileSync(join(outDir, "trace.json"), `${JSON.stringify(trace, null, 1)}\n`);
    }
    result.steps.oneFrameAfterWheel = await readMap();
    result.steps.oneFrameAfterWheel.hostPosition = host.state.position;
    await page.screenshot({ path: join(outDir, "02-just-after-wheel.png") });

    // --- SETTLE ------------------------------------------------------------------------------------------------
    await page.waitForTimeout(args.rtt + 1200);
    result.steps.settled = await readMap();
    result.steps.settled.hostPosition = host.state.position;
    result.steps.settled.hostTarget = host.state.target;
    await page.screenshot({ path: join(outDir, "03-settled.png") });

    // §7 SHIP GATE: with a tool armed the mirror must neither move the map nor send ANYTHING upstream for a wheel.
    if (args.tool === "armed") {
      result.toolArmed = {
        armedIcons,
        upstreamMessagesDuringWheel: host.state.inputs.slice(beforeInputs).map((i) => i.msg),
        composedTravelPx: Number(
          Math.abs(result.steps.composed.restComposedY - (mapNode.transform?.origin?.y ?? 0)).toFixed(2)
        ),
        onScreenTravelPx: result.steps.wheel.totalPx
      };
    }
    result.wheelMessages = host.state.inputs
      .slice(beforeInputs)
      .map((i) => i.msg)
      .filter((m) => m.kind === "click" && String(m.button).startsWith("wheel"));

    // --- R19 WP5 ENDPOINT EQUALITY: does the GAME end up where the CLIENT did? ----------------------------------
    //
    // A TRACKPAD gesture on purpose. Its travel (5 × deltaY 37, scaled by this stage's 1.5 design px per CSS px)
    // is 277.5 design px — deliberately not a whole multiple of the 80px wheel notch, because a distance the tick
    // wire CAN express would prove nothing. The relative path must round it to whole notches and glide the rest
    // away; the absolute path states the number.
    const absBase = {
      composed: canvasArm ? await readCanvasComposed(page, mapId) : await readComposed(page, mapSel),
      hostPosition: host.state.position,
      hostTarget: host.state.target,
      inputs: host.state.inputs.length,
      actions: host.state.actions.length
    };
    await page.evaluate(() => {
      const stage = document.querySelector(".mirror-stage") ?? document.body;
      for (let i = 0; i < 5; i++) {
        stage.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 37, deltaMode: 0, clientX: 640, clientY: 360, bubbles: true, cancelable: true })
        );
      }
    });
    // Long enough for the send, the host's lerp, the delta, the ack, and any settle glide to all be over.
    await page.waitForTimeout(args.rtt * 2 + 1500);
    const absEnd = {
      composed: canvasArm ? await readCanvasComposed(page, mapId) : await readComposed(page, mapSel),
      hostPosition: host.state.position,
      hostTarget: host.state.target
    };
    const clientTravel = absEnd.composed.composedY - absBase.composed.composedY;
    const hostTravel = absEnd.hostPosition - absBase.hostPosition;
    // Design px the gesture asked for: 5 events of 37 CSS px at this stage's 1080/720 design px per CSS px.
    const requestedTravel = 5 * 37 * (1080 / 720);
    result.steps.absolute = {
      requestedTravelPx: Number(requestedTravel.toFixed(2)),
      clientTravelPx: Number(clientTravel.toFixed(3)),
      hostTravelPx: Number(hostTravel.toFixed(3)),
      // AGREEMENT. Zero means the two endpoints are the SAME position, not merely close ones. Both paths reach it
      // — the relative one by the client giving in, which is what the next number exposes.
      endpointGapPx: Number(Math.abs(clientTravel - hostTravel).toFixed(3)),
      // THE GATE. How much of the player's gesture never happened. Nonzero on the relative path is the whole
      // reported defect: the scroll does not end where the player left it.
      gestureShortfallPx: Number(Math.abs(requestedTravel - Math.abs(clientTravel)).toFixed(3)),
      clientComposedY: Number(absEnd.composed.composedY.toFixed(3)),
      hostPositionY: Number(absEnd.hostPosition.toFixed(3)),
      hostTargetY: Number(absEnd.hostTarget.toFixed(3)),
      // The container's cosmetic translate at rest: "0px" means the client is not holding a lead any more, i.e.
      // the equality above is a settled fact rather than a snapshot mid-catch-up.
      translateAtRest: absEnd.composed.translate,
      // WHICH WIRE carried the gesture. Exactly one of these is non-empty, which is the other half of the claim:
      // the absolute channel REPLACES the tick replay rather than shadowing it.
      absoluteSends: host.state.actions.slice(absBase.actions).map((a) => ({ requested: a.requested, clamped: a.clamped })),
      wheelTicksSent: host.state.inputs
        .slice(absBase.inputs)
        .map((i) => i.msg)
        .filter((m) => m.kind === "click" && String(m.button).startsWith("wheel"))
    };

    // --- COMPENSATION: scroll then IMMEDIATELY tap --------------------------------------------------------------
    const tapBase = host.state.inputs.length;
    await page.evaluate(() => {
      const stage = document.querySelector(".mirror-stage") ?? document.querySelector("[data-mirror-stage]");
      const el = stage ?? document.body;
      for (let i = 0; i < 3; i++) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 640, clientY: 360, bubbles: true, cancelable: true }));
      }
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const leadState = await readMap();
    await page.evaluate(() => {
      const stage = document.querySelector(".mirror-stage") ?? document.querySelector("[data-mirror-stage]");
      const el = stage ?? document.body;
      const opts = { button: 0, clientX: 640, clientY: 360, bubbles: true, cancelable: true, pointerType: "mouse" };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    });
    await page.waitForTimeout(args.rtt + 200);
    result.steps.tapAfterScroll = {
      translateAtTap: leadState.translate,
      sent: host.state.inputs
        .slice(tapBase)
        .map((i) => i.msg)
        .filter((m) => m.kind === "click" && m.button === "left")
    };

    // The canvas stage's own counters at the end of the run — what a build and a paint actually cost here, which
    // is the context every number in `steps.builds` has to be read against.
    if (canvasArm) {
      result.canvasStats = await page.evaluate(() => {
        const read = window.__mirrorCanvasStats;
        if (typeof read !== "function") return null;
        const s = read();
        return {
          frames: s.frames,
          animFrames: s.animFrames,
          builds: s.builds,
          offsetBuilds: s.offsetBuilds,
          offsetCoalesced: s.offsetCoalesced,
          buildMsP50: s.buildMsP50,
          paintMsP50: s.paintMsP50,
          // The overlay reconcile's own p50 — a scroll gesture rebuilds every frame, so this probe is exactly where
          // a per-build overlay cost would show up if it is real.
          overlayMsP50: s.overlayMsP50,
          commands: s.commands,
          nodes: s.nodes,
          backingStore: s.backingStore
        };
      });
    }

    // THE OFF-SWITCH CONTRACT: every upstream message of the whole run, in order, so two `--eager off` runs across
    // a code change can be diffed byte-for-byte (`diff <a>/wire.json <b>/wire.json`).
    writeFileSync(
      join(outDir, "wire.json"),
      `${JSON.stringify(
        host.state.inputs.map((i) => i.msg),
        null,
        2
      )}\n`
    );
    writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!args.keep) {
      await browser.close();
      host.stop();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
