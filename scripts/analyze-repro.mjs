#!/usr/bin/env node
// ANALYZE a repro recording — read a "repro/1" file (written in the browser by
// frontend/src/mirror/reproRecorder.ts) and print what actually happened around each MARKER: the player's raw
// gesture, what this client sent and whether the game answered, and what the hand did.
//
//   node scripts/analyze-repro.mjs .sts2/repro/repro-2026-08-27T09-12-00-000Z.ndjson
//   node scripts/analyze-repro.mjs <file> --window 8            # ±8s around each marker (default 5)
//   node scripts/analyze-repro.mjs <file> --marker 2            # just that marker
//   node scripts/analyze-repro.mjs <file> --json out.json       # the same content, structurally
//   node scripts/analyze-repro.mjs --self-test                  # synthetic recording + assertions
//
// WHY THIS EXISTS SEPARATELY FROM THE REPLAYER. A recording answers two different kinds of question and they
// need different tools. "Did the client SEND anything when I hovered, and did the game ANSWER?" is a question
// about the file — no browser required, and this script answers it. "Does the card still jump on screen?" is a
// question about rendering, which needs the real client running against the recorded stream
// (scripts/replay-repro.mjs). Between them they split the three residual hand bugs cleanly: the focus-handoff
// and over-travel bugs are pure client rendering, while "focus stops responding after a cancelled drag" splits
// into "the client didn't send" (visible here) and "the game didn't answer" (also visible here).
//
// THE SCENE STATE IS THE REAL ONE. The mirror's own `parseSceneDelta` / `applySceneDelta` come straight from
// frontend/src/mirror/sceneTree.ts, so the tree this walks is the tree the browser built — not a
// re-implementation that can drift from it. They are loaded through `scripts/lib/mirror-probe.mjs`'s
// `loadSceneTree`, which owns the `registerHooks` alias/stub shim that makes a Vue-era `@/…` module tree
// importable under bare Node. (Not `compare-replay-final-state.mjs`'s bare `import()`: that predates
// sceneTree.ts gaining runtime imports and no longer resolves — see the note in mirror-probe.mjs.)
//
// WHAT IT DOES NOT DO: judge. It prints the timeline and flags the two things that are unambiguously wrong (a
// send with no answer, a marker with no input near it). Deciding which of those is the bug is the reader's job.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadSceneTree, REPO_ROOT } from "./lib/mirror-probe.mjs";
import { requireReproHeader } from "./lib/repro-recording.mjs";

// The scene node type each card in the hand hangs from. The hand bugs are all about WHERE these sit and WHICH
// one is on top, so every hand digest below is keyed on them. (mirrorRenderer.ts's HAND_HOLDER_TYPE.)
const HAND_HOLDER_TYPE = "NHandCardHolder";

// `nodeType` arrives fully qualified on the wire, so it is matched on its LAST dotted segment — the same rule
// the renderer uses (mirrorRenderer.ts's `nodeTypeLeaf`). Comparing the whole string instead finds nothing at
// all, silently, which is the shape of a report that says "no hand activity" about a combat recording.
function isHandHolder(node) {
  const type = node?.nodeType;
  return typeof type === "string" && type.slice(type.lastIndexOf(".") + 1) === HAND_HOLDER_TYPE;
}

// How long after a send we still call a scene-delta "the answer to it". Generous on purpose: at the default
// 24fps stream a frame is ~42ms, and a phone under load can be several frames behind — the point of the flag is
// to catch a send that was answered by NOTHING, not to grade latency.
const ANSWER_WINDOW_MS = 500;

// How many per-holder pose writes the TEXT report prints before it elides the middle (`--json` always has all).
const SAMPLE_DUMP_LIMIT = 40;

// ===========================================================================================================
// args
// ===========================================================================================================

function parseArgs(argv) {
  const a = { file: null, window: 5, marker: null, json: null, selfTest: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--window": a.window = Number(argv[++i]); break;
      case "--marker": a.marker = Number(argv[++i]); break;
      case "--json": a.json = argv[++i]; break;
      case "--self-test": a.selfTest = true; break;
      case "--quiet": a.quiet = true; break;
      case "-h":
      case "--help": a.help = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        a.file = arg;
    }
  }
  return a;
}

const HELP = `analyze-repro.mjs — read a "repro/1" recording and report what happened around each marker

  <file>               the .ndjson written by the in-browser repro recorder
  --window <s>         seconds either side of a marker to report (default 5)
  --marker <n>         only this marker (default: every marker; none ⇒ the whole file as one window)
  --json <path>        also write the report structurally
  --quiet              suppress the text report (use with --json)
  --self-test          build a synthetic recording, analyze it, assert the findings
`;

// ===========================================================================================================
// loading
// ===========================================================================================================

/** Read a headered repro/1 file into `{meta, lines}`. */
function loadRepro(path) {
  const abs = resolve(REPO_ROOT, path);
  const text = readFileSync(abs, "utf8");
  let meta = requireReproHeader(text, abs);
  const lines = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].length === 0) continue;
    let obj;
    try { obj = JSON.parse(raw[i]); } catch { continue; }
    if (i === 0) continue;
    lines.push(obj);
  }
  return { abs, meta, lines };
}

/** The windows to report on: one per marker (or the whole file when the recording has none). */
function windowsFor(meta, lines, args) {
  const markers = Array.isArray(meta.markers) && meta.markers.length
    ? meta.markers
    : lines.filter((l) => l.kind === "marker").map((l) => ({ n: l.n, t: l.t, note: l.note }));
  const chosen = args.marker === null ? markers : markers.filter((m) => m.n === args.marker);
  if (chosen.length) {
    const half = args.window * 1000;
    return chosen.map((m) => ({ label: `marker ${m.n}${m.note ? ` — ${m.note}` : ""}`, at: m.t, from: m.t - half, to: m.t + half }));
  }
  const last = lines.length ? lines[lines.length - 1].t ?? 0 : 0;
  // No marker at all is a legitimate file (a recorder armed by URL for a scripted run), so report the lot rather
  // than refusing — but say which case this is, because "no markers" usually means the player forgot to tap.
  return [{ label: "whole recording (no markers)", at: null, from: -Infinity, to: Infinity, whole: true, span: last }];
}

// ===========================================================================================================
// the hand digest
// ===========================================================================================================

/**
 * Fold ONE applied scene-delta into the per-window hand digest.
 *
 * Everything the three hand bugs are made of is here, and it is one function on purpose: the four signals only
 * mean anything read against each other (a y-change is "the lift" or "the tween" depending on whether a hint
 * armed it, and "focus moved" is only visible as the z-order flipping between two holders that are BOTH moving).
 *
 *   pose     — each holder's translation-Y and zIndex, sampled when a delta actually carried a change.
 *   order    — the holders' left-to-right order, and holders entering/leaving the fan (a drag reparents one OUT).
 *   focus    — which holder is on top (max zIndex, ties broken by paint order). The mirror expresses card focus
 *              as a z-lift, so this IS the focus timeline.
 *   tweens   — the declarative hints aimed at a holder (or at anything under one), with their endpoints, which
 *              is what tells an instant jump apart from an eased approach.
 *
 * `acc` is the window accumulator; pass null to fold state without recording (the run-up before a window).
 */
function digestHandDeltas(state, delta, t, holders, acc) {
  // --- keep the holder set current (cheap; a full scan only on a keyframe) ---
  if (delta.full) {
    holders.clear();
    for (const [id, node] of state.nodes) {
      if (isHandHolder(node)) holders.add(id);
    }
  } else {
    for (const upsert of delta.upserts) {
      if (isHandHolder(state.nodes.get(upsert.id))) holders.add(upsert.id);
    }
    for (const id of delta.removedIds) holders.delete(id);
  }
  if (!acc) return;

  // --- pose: only holders this delta actually wrote ---
  const touched = delta.full ? [...holders] : delta.upserts.map((u) => u.id).filter((id) => holders.has(id));
  for (const id of touched) {
    const node = state.nodes.get(id);
    if (!node) continue;
    const y = node.transform ? node.transform[5] : null;
    const z = node.zIndex ?? 0;
    const prev = acc.pose.get(id);
    if (prev && prev.y === y && prev.z === z) continue;
    acc.pose.set(id, { y, z });
    if (!acc.holders.has(id)) acc.holders.set(id, { id, samples: [], tweens: [] });
    acc.holders.get(id).samples.push({ t, y, z, dy: prev && prev.y !== null && y !== null ? round(y - prev.y, 2) : null });
  }

  // --- order + membership: the fan's shape, and a holder leaving it (which is what a drag does) ---
  const inFan = state.orderedIds.filter((id) => holders.has(id));
  const key = inFan.join(",");
  if (key !== acc.lastOrderKey) {
    acc.order.push({ t, ids: inFan, size: inFan.length });
    acc.lastOrderKey = key;
  }

  // --- focus: the top-of-stack holder. Ties go to the later paint (what a viewer sees on top). ---
  let focus = null;
  let bestZ = -Infinity;
  for (const id of inFan) {
    const z = state.nodes.get(id)?.zIndex ?? 0;
    if (z >= bestZ) { bestZ = z; focus = id; }
  }
  const focusKey = focus === null ? "none" : `${focus}@${bestZ}`;
  if (focusKey !== acc.lastFocusKey) {
    acc.focus.push({ t, id: focus, z: bestZ === -Infinity ? null : bestZ });
    acc.lastFocusKey = focusKey;
  }

  // --- tweens aimed at the hand ---
  for (const hint of delta.hints) {
    const owner = holderAncestor(state, hint.targetId, holders);
    if (!owner) continue;
    if (!acc.holders.has(owner)) acc.holders.set(owner, { id: owner, samples: [], tweens: [] });
    acc.holders.get(owner).tweens.push({
      t,
      target: hint.targetId,
      property: hint.property,
      durationMs: hint.durationMs,
      trans: hint.trans,
      ease: hint.ease,
      // The declarative endpoints are the whole point: an "instant jump then ease down" reads here as a start
      // whose Y is already at (or past) the end, or as no start at all where one was needed.
      startY: hint.startTransform ? round(hint.startTransform[5], 2) : null,
      endY: hint.endTransform ? round(hint.endTransform[5], 2) : null,
      endOpacity: hint.endOpacity
    });
  }
}

/** The holder a node hangs under (itself included), or null. Walks parents; the tree is shallow here. */
function holderAncestor(state, id, holders) {
  let cursor = id;
  for (let hops = 0; cursor && hops < 32; hops++) {
    if (holders.has(cursor)) return cursor;
    cursor = state.nodes.get(cursor)?.parentId ?? null;
  }
  return null;
}

// ===========================================================================================================
// the walk
// ===========================================================================================================

function round(value, places = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function newWindowAcc(win) {
  return {
    ...win,
    pointer: [],
    keys: [],
    wheels: [],
    sent: [],
    ws: [],
    inbound: 0,
    deltas: 0,
    // hand digest
    holders: new Map(),
    pose: new Map(),
    order: [],
    focus: [],
    lastOrderKey: null,
    lastFocusKey: null
  };
}

async function analyze(file, args) {
  const { abs, meta, lines } = loadRepro(file);
  const { createMirrorState, parseSceneDelta, applySceneDelta } = await loadSceneTree();

  const wins = windowsFor(meta, lines, args).map(newWindowAcc);
  const state = createMirrorState();
  const holders = new Set();
  const counts = { in: 0, out: 0, pointer: 0, wheel: 0, key: 0, marker: 0, ws: 0, resize: 0, other: 0 };
  // Every inbound frame's arrival time, so a send can be answered by "the next frame" rather than by a reply id.
  const inboundTimes = [];
  const repliesById = new Map();
  const pendingSends = [];

  for (const line of lines) {
    const t = typeof line.t === "number" ? line.t : 0;
    const live = wins.filter((w) => t >= w.from && t <= w.to);

    // A line with a `data` payload and no `dir` is a PASSIVE recording's frame (record-mirror-stream.mjs never
    // wrote a direction, because it only ever had one). Reading it as inbound is what lets this tool be pointed
    // at the existing `.sts2/bench/*.ndjson` corpus — the hand digest works there too, minus the input half.
    if (typeof line.data === "string" && line.dir !== "out") {
      counts.in++;
      inboundTimes.push(t);
      let raw;
      try { raw = JSON.parse(line.data); } catch { raw = null; }
      if (raw && typeof raw === "object") {
        if (typeof raw.requestId === "string") repliesById.set(raw.requestId, { t, type: raw.type, code: raw.code ?? null });
        let delta = null;
        try { delta = parseSceneDelta(raw); } catch { delta = null; }
        if (delta) {
          applySceneDelta(state, delta);
          for (const w of live) w.deltas++;
          // Folded for EVERY delta so holder identity is current across the whole file, and digested once per
          // window the delta falls in — markers closer together than 2×--window overlap, and each window's report
          // has to stand on its own. The holder-set update is idempotent, so folding twice changes nothing.
          if (live.length === 0) {
            digestHandDeltas(state, delta, t, holders, null);
          } else {
            for (const w of live) digestHandDeltas(state, delta, t, holders, w);
          }
          // Drain the tween/flight accumulators so the next delta's hints aren't re-counted.
          state.pendingHints.length = 0;
          state.pendingCardFlights.length = 0;
          state.changedIds.clear();
          state.sceneRewrite = false;
        }
      }
      for (const w of live) w.inbound++;
      continue;
    }

    if (line.dir === "out" && typeof line.data === "string") {
      counts.out++;
      let raw;
      try { raw = JSON.parse(line.data); } catch { raw = null; }
      const entry = {
        t,
        type: raw?.type ?? "?",
        requestId: raw?.requestId ?? null,
        summary: summarizeSend(raw),
        reply: null,
        nextFrameMs: null
      };
      pendingSends.push(entry);
      for (const w of live) w.sent.push(entry);
      continue;
    }

    switch (line.kind) {
      case "pointer":
        counts.pointer++;
        for (const w of live) w.pointer.push(line);
        break;
      case "wheel":
        counts.wheel++;
        for (const w of live) w.wheels.push(line);
        break;
      case "key":
        counts.key++;
        for (const w of live) w.keys.push(line);
        break;
      case "ws":
        counts.ws++;
        for (const w of live) w.ws.push(line);
        break;
      case "marker": counts.marker++; break;
      case "resize": counts.resize++; break;
      default: counts.other++;
    }
  }

  // Correlate the outgoing half AFTER the walk: a reply always lands later than its send, so this cannot be
  // done in one pass without holding everything anyway.
  for (const send of pendingSends) {
    if (send.requestId && repliesById.has(send.requestId)) {
      const reply = repliesById.get(send.requestId);
      send.reply = { type: reply.type, code: reply.code, afterMs: round(reply.t - send.t, 1) };
    }
    const next = inboundTimes.find((t) => t > send.t);
    send.nextFrameMs = next === undefined ? null : round(next - send.t, 1);
    // The flag the bug-1 diagnosis turns on: a send the wire produced NOTHING after. An `input` is never
    // answered by an id — its observable answer is the frame that follows it — so silence is the whole signal.
    send.unanswered = send.reply === null && (send.nextFrameMs === null || send.nextFrameMs > ANSWER_WINDOW_MS);
  }

  return { abs, meta, counts, windows: wins.map(finishWindow) };
}

function finishWindow(w) {
  return {
    label: w.label,
    at: w.at,
    from: w.whole ? 0 : round(w.from, 3),
    to: w.whole ? round(w.span, 3) : round(w.to, 3),
    inbound: w.inbound,
    deltas: w.deltas,
    pointer: coalescePointer(w.pointer, w.at),
    wheels: w.wheels.length,
    keys: w.keys.map((k) => ({ t: k.t, code: k.code })),
    ws: w.ws,
    sent: w.sent,
    hand: {
      order: w.order,
      focus: w.focus,
      holders: [...w.holders.values()]
    }
  };
}

/**
 * Collapse a pointer stream into readable runs.
 *
 * A hover across a hand is hundreds of `move` lines at frame cadence; printed one per line it buries the two
 * events that matter (the down and the up). A RUN is a maximal stretch of moves by one pointer, reported as its
 * endpoints, its count and its duration — which is also the shape a drag bug is argued in ("it went up 91px
 * over 6 frames, then back down").
 *
 * `t` on every entry is MILLISECONDS RELATIVE TO THE MARKER (negative before it), because the question a reader
 * arrives with is "what was I doing just before I tapped MARKER", not "how far into the file was this".
 */
function coalescePointer(events, origin) {
  const out = [];
  let run = null;
  const rel = (t) => round(origin === null ? t : t - origin, 3);
  const flush = () => {
    if (run) out.push(run);
    run = null;
  };
  for (const event of events) {
    if (event.type !== "move") {
      flush();
      out.push({ t: rel(event.t), type: event.type, x: event.x, y: event.y, id: event.id, pt: event.pt, button: event.button });
      continue;
    }
    if (run && run.id === event.id) {
      run.count++;
      run.toX = event.x;
      run.toY = event.y;
      run.ms = round(event.t - run.rawFrom, 1);
      continue;
    }
    flush();
    run = {
      t: rel(event.t), type: "move", id: event.id, pt: event.pt, count: 1,
      fromX: event.x, fromY: event.y, toX: event.x, toY: event.y, ms: 0, rawFrom: event.t
    };
  }
  flush();
  for (const entry of out) delete entry.rawFrom;
  return out;
}

function summarizeSend(raw) {
  if (!raw || typeof raw !== "object") return "(unparseable)";
  switch (raw.type) {
    case "input":
      return raw.kind === "key"
        ? `key ${raw.key}${raw.pressed === undefined ? "" : raw.pressed ? " down" : " up"}`
        : `${raw.kind}${raw.button ? ` ${raw.button}` : ""} coord=(${raw.coordX},${raw.coordY})${raw.count ? ` x${raw.count}` : ""}`;
    case "action":
      return `${raw.semanticActionId}${raw.args ? ` ${JSON.stringify(raw.args)}` : ""}`;
    case "join": return `name=${JSON.stringify(raw.name)}${raw.playerId ? ` playerId=${raw.playerId}` : ""}`;
    case "settings": return Object.keys(raw).filter((k) => k !== "type" && k !== "requestId").map((k) => `${k}=${raw[k]}`).join(" ");
    case "watch": return `on=${raw.on}`;
    case "scene-ack": return "";
    case "ping": return raw.mainThread ? "mainThread" : "";
    default: return "";
  }
}

// ===========================================================================================================
// report
// ===========================================================================================================

function fmtMs(ms) {
  return `${(ms / 1000).toFixed(3)}s`;
}

function signed(ms) {
  return `${ms < 0 ? "-" : "+"}${Math.abs(ms / 1000).toFixed(3)}`;
}

function report(result) {
  const { meta, counts } = result;
  const out = [];
  out.push(`${meta.format ?? "(no format)"}  ${result.abs}`);
  const viewport = meta.viewport ? `${meta.viewport.w}x${meta.viewport.h}` : "?";
  out.push(`  recorded ${meta.recordedAt ?? "?"}  viewport ${viewport} dpr ${meta.dpr ?? "?"} design ${meta.designWidth ?? "?"}`);
  if (meta.ua) out.push(`  ua ${meta.ua}`);
  out.push(`  lines in=${counts.in} out=${counts.out} pointer=${counts.pointer} wheel=${counts.wheel} key=${counts.key} ws=${counts.ws} marker=${counts.marker}`);
  // Every streamed transform is parent-relative, so hand y values below are travel within the fan rather than
  // screen positions. Said once here rather than on every line.
  out.push("  hand y below is parent-relative (fixed local transform contract)");
  if (meta.droppedLines) {
    // The ring overflowed, so the file starts mid-session — worth saying loudly, because "the recording begins
    // in the middle of a drag" is otherwise easy to read as "the client did nothing before this".
    out.push(`  DROPPED ${meta.droppedLines} lines / ${(meta.droppedBytes / 1048576).toFixed(1)} MB (buffer was full — the file starts mid-session)`);
  }
  if (meta.settings) {
    const interesting = ["raiseHandCards", "raiseHeldCard", "tapToFocus", "confirmTap", "unfocusOnRelease", "stretchEnabled", "tweenReplay", "refreshRate"];
    out.push(`  settings ${interesting.filter((k) => k in meta.settings).map((k) => `${k}=${meta.settings[k]}`).join(" ")}`);
  }

  for (const w of result.windows) {
    out.push("");
    out.push(`=== ${w.label} ${w.at === null ? "" : `@ ${fmtMs(w.at)}`}  [${fmtMs(w.from)} – ${fmtMs(w.to)}]  ${w.deltas} deltas ===`);

    out.push("");
    out.push("-- pointer --");
    if (w.pointer.length === 0) {
      // A marker with no input near it is itself a finding: whatever the player saw, they were not touching it.
      out.push("   (nothing — no pointer input in this window)");
    }
    for (const e of w.pointer) {
      out.push(e.type === "move"
        ? `   ${signed(e.t)}  move x${String(e.count).padStart(3)}  id=${e.id} ${e.pt}  (${e.fromX}, ${e.fromY}) → (${e.toX}, ${e.toY})  over ${e.ms}ms`
        : `   ${signed(e.t)}  ${e.type.padEnd(6)}      id=${e.id} ${e.pt}  (${e.x}, ${e.y})`);
    }
    for (const k of w.keys) out.push(`   ${fmtMs(k.t)}  key ${k.code}`);
    if (w.wheels) out.push(`   (${w.wheels} wheel events)`);

    out.push("");
    out.push("-- sent --");
    if (w.sent.length === 0) out.push("   (nothing — this client sent no envelope in this window)");
    for (const s of w.sent) {
      const answer = s.reply
        ? `${s.reply.type}${s.reply.code ? `/${s.reply.code}` : ""} +${s.reply.afterMs}ms`
        : s.nextFrameMs === null ? "NO FRAME AFTER IT" : `next frame +${s.nextFrameMs}ms`;
      out.push(`   ${fmtMs(s.t)}  ${String(s.type).padEnd(9)} ${s.summary}${s.requestId ? `  [${s.requestId}]` : ""}  → ${answer}${s.unanswered ? "   ⚠ UNANSWERED" : ""}`);
    }

    out.push("");
    out.push("-- hand --");
    if (w.hand.holders.length === 0) {
      out.push("   (no NHandCardHolder activity in this window)");
    } else {
      for (const o of w.hand.order) out.push(`   ${fmtMs(o.t)}  fan ${o.size}: ${o.ids.join(" ")}`);
      for (const f of w.hand.focus) out.push(`   ${fmtMs(f.t)}  focus(top-z) ${f.id ?? "none"}${f.z === null ? "" : ` z=${f.z}`}`);
      for (const h of w.hand.holders) {
        const ys = h.samples.filter((s) => s.y !== null);
        const range = ys.length ? `y ${ys[0].y} → ${ys[ys.length - 1].y}` : "y (never streamed)";
        out.push(`   ${h.id}  ${range}  over ${h.samples.length} writes`);
        // Capped: a holder eased across a long window is hundreds of sub-pixel writes, and the shape of the
        // motion is already in the head and tail. `--json` keeps every sample for anyone who needs them all.
        const shown = h.samples.length > SAMPLE_DUMP_LIMIT
          ? [...h.samples.slice(0, SAMPLE_DUMP_LIMIT / 2), null, ...h.samples.slice(-SAMPLE_DUMP_LIMIT / 2)]
          : h.samples;
        for (const s of shown) {
          out.push(s === null
            ? `      … ${h.samples.length - SAMPLE_DUMP_LIMIT} more writes (use --json for all of them)`
            : `      ${fmtMs(s.t)}  y=${s.y}${s.dy === null ? "" : ` (${s.dy >= 0 ? "+" : ""}${s.dy})`}  z=${s.z}`);
        }
        for (const tw of h.tweens) {
          out.push(`      ${fmtMs(tw.t)}  TWEEN ${tw.property} ${tw.durationMs}ms ${tw.trans ?? "?"}/${tw.ease ?? "?"}  y ${tw.startY ?? "—"} → ${tw.endY ?? "—"}  (target ${tw.target})`);
        }
      }
    }
  }
  return out.join("\n");
}

// ===========================================================================================================
// self-test
// ===========================================================================================================

/**
 * Build a synthetic repro file and assert the analysis finds what was planted in it. The scenario is a miniature
 * of bug 1: a drag on the edge holder, a cancel, then a hover whose `input` envelope the game never answers —
 * with a second holder taking focus so the hand digest has something to say.
 * (Precedent: replay-ws-server.mjs's --self-test.)
 */
async function runSelfTest() {
  const failures = [];
  const assert = (cond, what) => { if (!cond) failures.push(what); };

  const node = (id, extra = {}) => ({ id, parentId: null, name: id, nodeType: "Control", ...extra });
  // The WIRE transform shape the producer sends (sceneTree's normalizeTransform reads xAxis/yAxis/origin, NOT a
  // 6-tuple — the 6-tuple is the parsed form). A synthetic that got this wrong would silently produce a file with
  // no poses in it at all, which is exactly what this self-test caught the first time it ran.
  const holder = (id, y, z) =>
    node(id, {
      nodeType: HAND_HOLDER_TYPE,
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y } },
      zIndex: z
    });
  const deltaOf = (upserts, extra = {}) => JSON.stringify({
    type: "scene-delta", full: false, screenType: "run", upserts, removedIds: [], ...extra
  });
  const keyframe = JSON.stringify({
    type: "scene-delta",
    full: true,
    screenType: "run",
    upserts: [node("root"), holder("h1", 900, 0), holder("h2", 900, 0)],
    removedIds: [],
    orderedIds: ["root", "h1", "h2"]
  });

  const lines = [
    { meta: { format: "repro/1", recordedAt: "2026-08-27T00:00:00.000Z", viewport: { w: 2400, h: 1080 }, dpr: 2.75, designWidth: 2400, droppedLines: 0, droppedBytes: 0, settings: { raiseHandCards: true }, markers: [{ n: 1, t: 3000 }] } },
    { t: 0, dir: "in", data: keyframe },
    { t: 100, kind: "pointer", type: "down", x: 1200, y: 950, id: 1, pt: "touch", button: 0, buttons: 1, primary: true },
    { t: 116, kind: "pointer", type: "move", x: 1200, y: 900, id: 1, pt: "touch" },
    { t: 132, kind: "pointer", type: "move", x: 1200, y: 850, id: 1, pt: "touch" },
    { t: 148, kind: "pointer", type: "move", x: 1200, y: 800, id: 1, pt: "touch" },
    { t: 150, dir: "out", data: JSON.stringify({ type: "input", requestId: "input:1", kind: "hover", coordX: 960, coordY: 640 }) },
    // …answered: a frame follows promptly, and the dragged holder lifts + takes the z-lift.
    { t: 180, dir: "in", data: deltaOf([holder("h1", 700, 20)]) },
    { t: 200, dir: "in", data: deltaOf([holder("h1", 651, 20)], { hints: [{ targetId: "h1", property: "transform", durationMs: 200, trans: "quad", ease: "out", endTransform: [1, 0, 0, 1, 100, 651] }] }) },
    { t: 400, kind: "pointer", type: "up", x: 1200, y: 950, id: 1, pt: "touch" },
    // The cancel: focus hands back to the other holder.
    { t: 420, dir: "in", data: deltaOf([holder("h1", 900, 0), holder("h2", 820, 30)]) },
    // …and now the hover that goes UNANSWERED — the shape of bug 1.
    { t: 2900, dir: "out", data: JSON.stringify({ type: "input", requestId: "input:2", kind: "hover", coordX: 970, coordY: 640 }) },
    { t: 3000, kind: "marker", n: 1 },
    { t: 9000, dir: "in", data: deltaOf([holder("h2", 820, 30)]) }
  ];

  const dir = mkdtempSync(join(tmpdir(), "analyze-repro-selftest-"));
  const file = join(dir, "synthetic.ndjson");
  const headerless = join(dir, "headerless.ndjson");
  try {
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    writeFileSync(headerless, `${JSON.stringify(lines[1])}\n`);
    try {
      await analyze(headerless, { window: 5, marker: null, json: null });
      assert(false, "headerless recordings are rejected");
    } catch (error) {
      assert(/repro\/1/.test(String(error.message)), `headerless rejection explains the required format (${error.message})`);
    }
    const result = await analyze(file, { window: 5, marker: null, json: null });

    assert(result.meta.format === "repro/1", "meta.format read");
    assert(result.counts.in === 5, `5 inbound lines (got ${result.counts.in})`);
    assert(result.counts.out === 2, `2 outbound lines (got ${result.counts.out})`);
    assert(result.counts.pointer === 5, `5 pointer lines (got ${result.counts.pointer})`);
    assert(result.windows.length === 1, `one window for one marker (got ${result.windows.length})`);

    const w = result.windows[0];
    assert(w.label === "marker 1", `window is named for its marker (got ${w.label})`);

    // POINTER: the three moves collapse into ONE run with its endpoints kept.
    const moves = w.pointer.filter((p) => p.type === "move");
    assert(moves.length === 1, `3 moves coalesce to 1 run (got ${moves.length})`);
    assert(moves[0].count === 3, `run counts its moves (got ${moves[0]?.count})`);
    assert(moves[0].fromY === 900 && moves[0].toY === 800, "run keeps its endpoints");
    assert(w.pointer[0].type === "down" && w.pointer[w.pointer.length - 1].type === "up", "down/up survive coalescing");
    // Offsets are relative to the marker, so a reader can see how long BEFORE it each thing happened.
    assert(w.pointer[0].t === -2900, `offsets are ms relative to the marker (got ${w.pointer[0].t})`);

    // SENT: the first hover was answered by the next frame; the second was answered by nothing.
    assert(w.sent.length === 2, `both sends in the window (got ${w.sent.length})`);
    assert(w.sent[0].summary === "hover coord=(960,640)", `send summarised (got ${w.sent[0].summary})`);
    assert(w.sent[0].nextFrameMs === 30, `answered send times the next frame (got ${w.sent[0].nextFrameMs})`);
    assert(w.sent[0].unanswered === false, "a send followed by a frame is not flagged");
    assert(w.sent[1].unanswered === true, "a send with no frame within 500ms IS flagged");

    // HAND: both holders seen, the lift measured, the tween's endpoint read, focus handed over.
    const byId = Object.fromEntries(w.hand.holders.map((h) => [h.id, h]));
    assert(Boolean(byId.h1 && byId.h2), "both holders digested");
    const h1 = byId.h1.samples;
    assert(h1.some((s) => s.y === 651 && s.dy === -49), `the lift is measured as a delta (got ${JSON.stringify(h1.map((s) => s.dy))})`);
    assert(byId.h1.tweens.length === 1 && byId.h1.tweens[0].endY === 651, "the hand tween's endpoint is read");
    const focusIds = w.hand.focus.map((f) => f.id);
    assert(focusIds.includes("h1") && focusIds.includes("h2"), `focus handoff timeline (got ${focusIds.join(",")})`);
    assert(focusIds[focusIds.length - 1] === "h2", "focus ends on the second holder");
    assert(w.hand.order.length >= 1 && w.hand.order[0].size === 2, "the fan's size is reported");

    // The text report must actually mention the two things a human reads it for.
    const text = report(result);
    assert(text.includes("UNANSWERED"), "the report flags the unanswered send");
    assert(text.includes("TWEEN transform"), "the report shows the hand tween");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length === 0) {
    console.log("SELF-TEST: PASS (repro/1 header + windows + pointer coalescing + send correlation + hand digest + report)");
    process.exit(0);
  }
  console.error(`SELF-TEST: FAIL\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

// ===========================================================================================================
// main
// ===========================================================================================================

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.selfTest) {
  await runSelfTest();
} else if (!args.file) {
  console.error(HELP);
  process.exit(2);
} else {
  const result = await analyze(args.file, args);
  if (!args.quiet) console.log(report(result));
  if (args.json) {
    writeFileSync(resolve(REPO_ROOT, args.json), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\njson: ${resolve(REPO_ROOT, args.json)}`);
  }
}
