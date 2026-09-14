// Tier (i): deterministic, in-process replay bench for the live-tree MIRROR pipeline.
//
//   cd frontend && npm run bench:mirror
//   COUCHCOOP_BENCH_RECORDING=/abs/path/to/combat.ndjson npm run bench:mirror
//
// Replays a recorded combat scene-delta stream (scripts/record-mirror-stream.mjs) through the REAL parse +
// apply + reconcile code and reports the CPU cost of each stage, so a renderer/apply optimization can be
// measured with zero network/browser variance. This is the cheap, deterministic companion to the playwright
// CDP bench (scripts/bench-mirror-replay.mjs) — it isolates the JS work the perf trace flagged (JSON.parse,
// applySceneDelta, mirrorRenderer.reconcile) without SwiftShader/compositor noise.
//
// Runs in jsdom, so WebGL/canvas paints no-op (getContext returns null) exactly like the existing renderer
// spec — the reconcile still does its DOM diff, transform math, style writes and structural walks, which is
// the flagged hot path.
//
// This file uses plain `it()` (run via `vitest run`), not vitest's `bench()` microbench API — the phases are
// timed manually and printed as `BENCH_RESULT {json}` + a human table for the perf log.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it } from "vitest";

import { requireReproHeader } from "./reproRecording";

import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  MIRROR_DESIGN_WIDTH,
  MIRROR_MAX_DESIGN_WIDTH,
  type MirrorDelta
} from "../src/mirror/sceneTree";
// Whole-module import so a walk-stats export added by a LATER workstream is read defensively (absent now).
import * as rendererModule from "../src/mirror/mirrorRenderer";
import { mirrorSettings } from "../src/mirror/mirrorSettings";

const { createMirrorRenderer, isCombatBackgroundSceneRoot } = rendererModule;

// ---------------------------------------------------------------------------------------------------------
// R12 — THE STATIC-BACKGROUND ARM (`COUCHCOOP_BENCH_STATIC_BG=on|off|both`, default `both`)
// ---------------------------------------------------------------------------------------------------------
//
// This bench never called `setStaticBackgroundShown`, so it had always measured the LIVE-bg path by accident.
// R12 makes the build hold renderer-derived from `mirrorSettings` (default on), so with no arm the bench would
// silently flip to measuring the HELD path — and then flip back mid-run when the 8s belt expired, making old and
// new numbers incomparable with no signal at all. So the arm is explicit and no number is ever reported without it:
//   `off` — `staticBgEnabled = false`: today's live-bg path, so the historical series stays comparable.
//   `on`  — the hold engaged for the whole run (the belt pinned to Infinity so it cannot expire mid-measurement),
//           standing in for StaticBackground.vue by confirming each room's image as its bg root appears.
type StaticBgArm = "on" | "off";

function staticBgArms(): StaticBgArm[] {
  const raw = (process.env.COUCHCOOP_BENCH_STATIC_BG ?? "both").toLowerCase();
  if (raw === "on") return ["on"];
  if (raw === "off") return ["off"];
  return ["off", "on"];
}

// ---------------------------------------------------------------------------------------------------------
// Recording discovery + load
// ---------------------------------------------------------------------------------------------------------

interface Recording {
  path: string;
  meta: Record<string, unknown>;
  // Raw message strings (server-reload stripped), in recorded order, with their relative timestamps.
  messages: { t: number; data: string }[];
}

function benchDir(): string {
  // Vitest runs with cwd = frontend/. Recordings live at <repo-root>/.sts2/bench (i.e. ../.sts2/bench).
  return resolve(process.cwd(), "../.sts2/bench");
}

function newestRecording(): string | null {
  let dir: string;
  try {
    dir = benchDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => resolve(dir, f));
    if (files.length === 0) {
      return null;
    }
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0];
  } catch {
    return null;
  }
}

function loadRecording(): Recording | null {
  const path = process.env.COUCHCOOP_BENCH_RECORDING || newestRecording();
  if (!path) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const meta = requireReproHeader(text, path);
  const messages: { t: number; data: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (i === 0) continue;
    // A repro recording (frontend/src/mirror/reproRecorder.ts, format "repro/1") interleaves the client's OWN
    // sends as `dir:"out"` alongside the inbound stream. The inbound half alone is what a replay consumes, so a
    // repro file can be benched exactly like a passive recording — as long as the outbound half is dropped here.
    if (obj.dir === "out") {
      continue;
    }
    const data = typeof obj.data === "string" ? obj.data : null;
    if (data === null) {
      continue;
    }
    // `server-reload` is a dev-only signal — strip it from replay (matches the real client's handling).
    if (data.includes('"type":"server-reload"')) {
      continue;
    }
    messages.push({ t: typeof obj.t === "number" ? obj.t : 0, data });
  }
  return { path, meta, messages };
}

const recording = loadRecording();

// ---------------------------------------------------------------------------------------------------------
// jsdom shims
// ---------------------------------------------------------------------------------------------------------

// jsdom is missing a couple of browser APIs the real combat data exercises (the synthetic renderer-spec
// nodes don't). Shim them so reconcile measures its CPU cost without throwing. Canvas getContext already
// returns null under jsdom and the renderer guards it (the "Not implemented" warnings are benign).
function installBrowserShims(): void {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  // The renderer schedules rAF loops (spine/intent/tween replay). Callbacks fire on a macrotask, never
  // mid-measurement (the replay loops are synchronous); renderer.dispose() cancels them between runs.
  if (typeof g.requestAnimationFrame !== "function") {
    g.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number;
    g.cancelAnimationFrame = (h: number) => clearTimeout(h as unknown as NodeJS.Timeout);
  }
  // WAAPI: the intent-wave path phase-shifts CSS animations via el.getAnimations(). jsdom has no WAAPI, so
  // return an empty list (the honest jsdom behavior — nothing to phase-shift).
  const proto = globalThis.Element?.prototype as unknown as { getAnimations?: () => unknown[] };
  if (proto && typeof proto.getAnimations !== "function") {
    proto.getAnimations = () => [];
  }
  // jsdom's getContext returns null and logs a "Not implemented" warning for EVERY atlas/spine canvas — with
  // a real combat recording that's tens of thousands of lines of stderr I/O that both dwarfs and corrupts the
  // timing. Return a no-op 2D context stub so the renderer's canvas-paint code runs (representative) and jsdom
  // never logs. The renderer only asks for "2d"; the WebGL shader/particle runtimes live in MirrorView (gsw),
  // not the reconciler, so they aren't created here.
  const canvasProto = globalThis.HTMLCanvasElement?.prototype as unknown as {
    getContext?: (type: string) => unknown;
    __benchStubbed?: boolean;
  };
  if (canvasProto && !canvasProto.__benchStubbed) {
    canvasProto.__benchStubbed = true;
    canvasProto.getContext = function fakeGetContext(this: HTMLCanvasElement, type: string): unknown {
      if (type !== "2d") {
        return null;
      }
      const noop = () => undefined;
      const store: Record<string | symbol, unknown> = { canvas: this };
      return new Proxy(store, {
        get(target, prop) {
          if (prop in target) {
            return target[prop];
          }
          if (prop === "measureText") {
            return () => ({ width: 0 });
          }
          if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") {
            return () => ({ addColorStop: noop });
          }
          if (prop === "getImageData") {
            return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
          }
          return noop; // any other CanvasRenderingContext2D method → no-op
        },
        set(target, prop, value) {
          target[prop] = value;
          return true;
        }
      });
    };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const WIDE_STRETCH = MIRROR_MAX_DESIGN_WIDTH / MIRROR_DESIGN_WIDTH; // 2520/1920 = 1.3125
const RAF_WINDOW_MS = 1000 / 60; // 16.667ms coalescing bucket, matching MirrorView.scheduleRender
const RECONCILE_REPEATS = 3;

// A fresh stage + <defs> like the renderer spec harness.
function makeStage(): { stage: HTMLElement; defs: SVGDefsElement; teardown: () => void } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs") as SVGDefsElement;
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return {
    stage,
    defs,
    teardown: () => {
      stage.remove();
      svg.remove();
    }
  };
}

// One reconcile-variant run. `deltas` are pre-parsed (fresh objects, so the renderer/apply never sees a state
// mutated by a previous run). We time ONLY renderer.reconcile — parse/apply are measured in their own phases.
function runReconcileVariant(
  deltas: { t: number; delta: MirrorDelta }[],
  pacing: "per-message" | "raf",
  stretch: number,
  staticBg: StaticBgArm
): { reconcileMs: number; reconciles: number } {
  const { stage, defs, teardown } = makeStage();
  const renderer = createMirrorRenderer(stage, defs);
  if (stretch !== 1) {
    renderer.setStretch(stretch); // MirrorView sets the spread factor before the first reconcile
  }
  const state = createMirrorState();

  // The arm. `staticBgFailedOpen` is cleared either way — a previous run's fail-open latch must not leak into this one.
  mirrorSettings.staticBgEnabled = staticBg === "on";
  mirrorSettings.staticBgFailedOpen = false;
  // Pin the renderer's belt-and-braces clock so the hold cannot expire PART WAY through a measured run (which would
  // silently mix both arms into one number). The component's stand-in below is what a real session relies on.

  // StaticBackground.vue's stand-in: confirm the mounted room's image as soon as its bg root appears on the wire.
  // Only re-scanned when the structure moved (orderedIds identity), the same rule the component's fallback uses.
  let lastScanned: readonly string[] | null = null;
  let shownScenePath: string | null = null;
  const confirmShownImage = () => {
    if (state.orderedIds === lastScanned) {
      return;
    }
    lastScanned = state.orderedIds;
    let found: string | null = null;
    for (const [, node] of state.nodes) {
      if (node.sceneFilePath && isCombatBackgroundSceneRoot(node, state.nodes)) {
        found = node.sceneFilePath;
        break;
      }
    }
    if (found !== shownScenePath) {
      shownScenePath = found;
      renderer.setStaticBackgroundShown(found);
    }
  };

  let reconcileMs = 0;
  let reconciles = 0;
  const reconcile = (force: boolean) => {
    const t0 = performance.now();
    renderer.reconcile(state, force ? { forceTextures: true } : undefined);
    reconcileMs += performance.now() - t0;
    reconciles += 1;
  };

  if (pacing === "per-message") {
    for (const { delta } of deltas) {
      applySceneDelta(state, delta);
      if (staticBg === "on") {
        confirmShownImage(); // outside the timed bracket: it stands in for a Vue component, not for renderer work
      }
      reconcile(false);
    }
  } else {
    let nextFlush = RAF_WINDOW_MS;
    let dirty = false;
    for (const { t, delta } of deltas) {
      applySceneDelta(state, delta);
      dirty = true;
      if (t >= nextFlush) {
        if (staticBg === "on") {
          confirmShownImage();
        }
        reconcile(false);
        dirty = false;
        while (nextFlush <= t) {
          nextFlush += RAF_WINDOW_MS;
        }
      }
    }
    if (dirty) {
      if (staticBg === "on") {
        confirmShownImage();
      }
      reconcile(false); // final coalesced flush
    }
  }

  if (stretch !== 1) {
    // Mirror the spread/texture-size watchers: a widened viewer forces one structural forceTextures re-touch.
    reconcile(true);
  }

  renderer.dispose();
  teardown();
  return { reconcileMs, reconciles };
}

// ---------------------------------------------------------------------------------------------------------
// The bench
// ---------------------------------------------------------------------------------------------------------

describe("mirror combat replay bench (tier i)", () => {
  if (!recording) {
    it.skip(
      "skipped — no recording (set COUCHCOOP_BENCH_RECORDING or record one to .sts2/bench/*.ndjson via scripts/record-mirror-stream.mjs)",
      () => {
        /* skipped */
      }
    );
    // eslint-disable-next-line no-console
    console.log(
      "\n[bench:mirror] SKIPPED — no recording found. Capture one with:\n" +
        "  node scripts/record-mirror-stream.mjs --out .sts2/bench/combat-baseline.ndjson\n"
    );
    return;
  }

  it("replays the recorded combat stream through parse + apply + reconcile", () => {
    installBrowserShims();

    const rec = recording;
    const messages = rec.messages;

    // --- Phase 1: JSON.parse every message string (realistic parse cost, incl. non-scene-delta frames) ----
    // Warm once (discarded) so JIT/first-parse cost doesn't dominate the single measured pass.
    for (const m of messages) {
      JSON.parse(m.data);
    }
    let parseAllMs = 0;
    {
      const t0 = performance.now();
      for (const m of messages) {
        JSON.parse(m.data);
      }
      parseAllMs = performance.now() - t0;
    }

    // Pre-parse the JSON once (so phase 2 isolates parseSceneDelta+applySceneDelta, and phase 3 isolates
    // reconcile). Kept as {t, obj}.
    const parsed = messages.map((m) => ({ t: m.t, obj: JSON.parse(m.data) as unknown }));

    // --- Phase 2: parseSceneDelta + applySceneDelta into a fresh retained state ---------------------------
    // Warm once (build a throwaway state) then measure. This is the cheap "apply the delta to the map" side
    // the design deliberately keeps light; the reconcile below is the expensive side.
    const buildDeltas = (): { t: number; delta: MirrorDelta }[] => {
      const out: { t: number; delta: MirrorDelta }[] = [];
      const state = createMirrorState();
      for (const { t, obj } of parsed) {
        const delta = parseSceneDelta(obj);
        if (delta) {
          applySceneDelta(state, delta);
          out.push({ t, delta });
        }
      }
      return out;
    };
    buildDeltas(); // warm
    let applyMs = 0;
    let deltaCount = 0;
    {
      const t0 = performance.now();
      const built = buildDeltas();
      applyMs = performance.now() - t0;
      deltaCount = built.length;
    }

    // Reusable pre-parsed deltas for the reconcile phase. Each variant run re-parses fresh objects so no run
    // sees state mutated by another; we parse per-run inside the variant loop below.
    const preParseDeltas = (): { t: number; delta: MirrorDelta }[] => {
      const out: { t: number; delta: MirrorDelta }[] = [];
      for (const { t, obj } of parsed) {
        const delta = parseSceneDelta(obj);
        if (delta) {
          out.push({ t, delta });
        }
      }
      return out;
    };

    // --- Phase 3: reconcile — {per-message, rAF-coalesced} x {stretch 1, widened} -------------------------
    interface ReconcileConfig {
      label: string;
      pacing: "per-message" | "raf";
      stretch: number;
      staticBg: StaticBgArm;
    }
    const arms = staticBgArms();
    const configs: ReconcileConfig[] = arms.flatMap((staticBg) => [
      { label: `per-message @1.0 bg:${staticBg}`, pacing: "per-message" as const, stretch: 1, staticBg },
      { label: `per-message @wide bg:${staticBg}`, pacing: "per-message" as const, stretch: WIDE_STRETCH, staticBg },
      { label: `rAF-16.7ms @1.0 bg:${staticBg}`, pacing: "raf" as const, stretch: 1, staticBg },
      { label: `rAF-16.7ms @wide bg:${staticBg}`, pacing: "raf" as const, stretch: WIDE_STRETCH, staticBg }
    ]);

    // Global warmup: one full per-message run so the renderer's code paths are JITed before measuring.
    runReconcileVariant(preParseDeltas(), "per-message", 1, arms[0]);

    // Per-variant static-bg accounting, read off the module-singleton stats as a DELTA across the run: a bench that
    // cannot say whether the hold was engaged is a bench that cannot be compared to anything.
    const bgStats = () => {
      const s = rendererModule.mirrorWalkStats as unknown as Record<string, number> | undefined;
      return {
        held: Number(s?.staticBgHeldRoots ?? 0),
        skipped: Number(s?.staticBgHoldSkippedBuilds ?? 0),
        expiries: Number(s?.staticBgHoldExpiries ?? 0)
      };
    };

    const reconcileResults = configs.map((cfg) => {
      const runs: number[] = [];
      let reconciles = 0;
      let heldRoots = 0;
      const before = bgStats();
      for (let i = 0; i < RECONCILE_REPEATS; i++) {
        // Fresh deltas per run → no cross-run state contamination.
        const r = runReconcileVariant(preParseDeltas(), cfg.pacing, cfg.stretch, cfg.staticBg);
        runs.push(r.reconcileMs);
        reconciles = r.reconciles;
        heldRoots = bgStats().held;
      }
      const after = bgStats();
      const medianMs = median(runs);
      return {
        label: cfg.label,
        pacing: cfg.pacing,
        stretch: round2(cfg.stretch),
        staticBg: cfg.staticBg,
        reconciles,
        medianReconcileMs: round2(medianMs),
        msPerReconcile: reconciles > 0 ? round2(medianMs / reconciles) : 0,
        // >0 in an `on` arm is the PROOF the live bg subtree was never built; 0 there means the recording has no
        // combat bg root (or the hold failed open) and the number is really an `off`-arm number wearing a label.
        staticBgHeldRoots: heldRoots,
        staticBgHoldSkippedBuilds: after.skipped - before.skipped,
        staticBgHoldExpiries: after.expiries - before.expiries
      };
    });
    // Leave the store the way the process found it (vitest may run other files in this worker).
    mirrorSettings.staticBgEnabled = true;
    mirrorSettings.staticBgFailedOpen = false;

    // --- Walk stats (defensive — a later workstream adds mirrorWalkStats) ---------------------------------
    const walkStats = (rendererModule as Record<string, unknown>).mirrorWalkStats as
      | Record<string, unknown>
      | undefined;
    const walkStatsSnapshot =
      walkStats && typeof walkStats === "object"
        ? Object.fromEntries(
            Object.entries(walkStats).filter(([, v]) => typeof v === "number")
          )
        : null;

    // --- Report -------------------------------------------------------------------------------------------
    // process.stdout.write bypasses vitest's console interception (which swallows test-body console.log on a
    // passing run), so the BENCH_RESULT line + table always reach the terminal / a piped log.
    const emit = (line = "") => process.stdout.write(line + "\n");

    const result = {
      recording: {
        path: rec.path,
        messages: messages.length,
        deltas: deltaCount,
        bytes: rec.meta.bytes ?? null,
        durationMs: rec.meta.durationMs ?? null,
        recordedAt: rec.meta.recordedAt ?? null
      },
      parseAllMs: round2(parseAllMs),
      applyMs: round2(applyMs),
      staticBgArms: arms,
      reconcile: reconcileResults,
      walkStats: walkStatsSnapshot
    };

    emit("");
    emit("=== mirror combat replay bench (tier i) ===");
    emit(`recording:        ${rec.path}`);
    emit(
      `                  ${messages.length} messages (${deltaCount} scene-deltas), ` +
        `${rec.meta.bytes ?? "?"} bytes, ${rec.meta.durationMs ?? "?"}ms span`
    );
    emit(`JSON.parse all:   ${round2(parseAllMs)} ms  (${round2(parseAllMs / messages.length)} ms/msg)`);
    emit(`parse+apply:      ${round2(applyMs)} ms  (${round2(applyMs / Math.max(1, deltaCount))} ms/delta)`);
    emit(`static bg arms:   ${arms.join(", ")}  (COUCHCOOP_BENCH_STATIC_BG=on|off|both)`);
    emit(`reconcile (median of ${RECONCILE_REPEATS}):`);
    emit("  variant                     reconciles   total ms   ms/reconcile   bgHeld   bgSkippedBuilds");
    for (const r of reconcileResults) {
      emit(
        "  " +
          r.label.padEnd(27) +
          String(r.reconciles).padStart(9) +
          r.medianReconcileMs.toFixed(2).padStart(11) +
          r.msPerReconcile.toFixed(3).padStart(15) +
          String(r.staticBgHeldRoots).padStart(9) +
          String(r.staticBgHoldSkippedBuilds).padStart(18)
      );
    }
    for (const r of reconcileResults) {
      if (r.staticBg === "on" && r.staticBgHoldSkippedBuilds === 0) {
        emit(
          `  !! ${r.label}: static bg was NOT engaged (0 held builds) — this is a FAIL-OPEN run; ` +
            "the recording has no combat bg root, or the hold released. Do not compare it as an `on` number."
        );
      }
      if (r.staticBgHoldExpiries > 0) {
        emit(`  !! ${r.label}: ${r.staticBgHoldExpiries} belt expiries — the hold released mid-run (bug report).`);
      }
    }
    emit(`walkStats: ${walkStatsSnapshot ? JSON.stringify(walkStatsSnapshot) : "n/a"}`);
    emit("BENCH_RESULT " + JSON.stringify(result));
    emit("");
  });
});
