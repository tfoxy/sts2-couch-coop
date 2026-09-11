// Does the game actually CHANGE its shaders? Measured, on recorded real sessions.
//
//   cd frontend && npx vitest run bench/shaderChurn.bench.ts
//   COUCHCOOP_BENCH_RECORDING=/abs/path/to/x.ndjson npx vitest run bench/shaderChurn.bench.ts
//
// WHY THIS EXISTS. `packages/html/src/webgl/runtime.ts` keeps a `staticFrameCache` keyed by shader + size +
// texture identity + modulate + uv-window + quantized params. Whether a finished shader surface can become a
// plain `<img>` (6 compositor layers instead of 31, measured in gsw's S5 scenario) hinges on ONE fact: does a
// given node's key ever change during play? If it does not, the surface is finished for the life of the node
// and an `<img>` is strictly better. If it does, an `<img>` has to be RE-ENCODED on every change, which S5
// measured as the case where canvas wins.
//
// That fact was ASSERTED in both directions before anyone counted it. This counts it, on the real wire stream
// from real sessions, through the real parser — no browser, no renderer, no guessing.
//
// WHAT IT MEASURES, precisely: for every node that carries a `shaderId`, the number of DISTINCT values of each
// key component observed across the whole recording, and — because "changed at all" is too blunt to act on —
// WHICH component changed and how often. A node whose params churn every tick is a different problem from one
// that changes twice in 25 seconds.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { requireReproHeader } from "./reproRecording";

import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
} from "../src/mirror/sceneTree";

interface Recording {
  name: string;
  messages: string[];
}

function benchDir(): string {
  return resolve(process.cwd(), "../.sts2/bench");
}

function loadRecording(path: string): Recording {
  const text = readFileSync(path, "utf8");
  requireReproHeader(text, path);
  const lines = text.split("\n").filter(Boolean);
  const messages: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (i === 0) continue;
    const data = typeof obj.data === "string" ? obj.data : null;
    if (data === null || data.includes('"type":"server-reload"')) continue;
    messages.push(data);
  }
  return { name: path.split("/").pop() ?? path, messages };
}

function recordings(): Recording[] {
  const explicit = process.env.COUCHCOOP_BENCH_RECORDING;
  if (explicit) return [loadRecording(explicit)];
  let files: string[];
  try {
    files = readdirSync(benchDir())
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => resolve(benchDir(), f));
  } catch {
    return [];
  }
  // Newest first, and bounded: this is a diagnostic, not a soak. The whole corpus is ~150 MB.
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files.slice(0, 12).map(loadRecording);
}

/**
 * The wire-visible half of `staticFrameKey`, component by component.
 *
 * Deliberately NOT one concatenated string: the actionable question is not "did the frame change" but "what
 * changed", because the answer decides whether an `<img>` swap needs a re-encode path at all.
 *
 * `size` and `window` are excluded — they are layout, computed in the browser from the fitted viewport, and a
 * headless replay cannot produce honest values for them. Stated rather than silently approximated.
 */
// The runtime quantizes every numeric key input to 2dp (`quantizeForKey`) precisely so streamed jitter
// collapses to one cache entry. Comparing raw values would count jitter as churn and manufacture the
// conclusion this bench is supposed to test.
function quantize(value: unknown): unknown {
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

function keyParts(node: MirrorNode): Record<string, string> {
  const params = (node.shaderParams ?? [])
    .map(
      (p) =>
        `${p.name}=${JSON.stringify({ ...p, name: undefined }, (_k, v) => quantize(v))}`,
    )
    .sort()
    .join("|");
  const modulate = node.modulate
    ? [node.modulate.r, node.modulate.g, node.modulate.b, node.modulate.a]
        .map((v) => Math.round(v * 100) / 100)
        .join(",")
    : "";
  return {
    shaderId: node.shaderId ?? "",
    params,
    // Per-param, so the answer names the uniform rather than "something changed".
    ...Object.fromEntries(
      (node.shaderParams ?? []).map((p) => [
        `param:${p.name}`,
        JSON.stringify({ ...p, name: undefined }, (_k, v) => quantize(v)),
      ]),
    ),
    // Split out, because S5 says an alpha-only change is free (the mirror applies alpha as CSS opacity, not
    // into the shader frame) while an RGB change is a real re-encode.
    modulateRgb: modulate.split(",").slice(0, 3).join(","),
    modulateAlpha: modulate.split(",")[3] ?? "",
    textureUrl: node.textureUrl ?? "",
    // THE SIZE QUESTION. The canvas backing store is the element's CONTENT BOX (× window du/dv × dpr), and
    // the element's box is `localRect` — which is streamed, so it is measurable here. A Godot `scale` lands
    // in `transform` instead and becomes a CSS matrix, which does NOT move the content box and therefore
    // cannot realloc the canvas. Tracking the two SEPARATELY is what distinguishes "focus resizes the
    // canvas and forces a re-render" from "focus is a transform and the cached frame is reused as-is".
    box: node.localRect
      ? `${Math.round(node.localRect.width * 100) / 100}x${Math.round(node.localRect.height * 100) / 100}`
      : "",
    transform: node.transform ? node.transform.map((v) => Math.round(v * 100) / 100).join(",") : "",
  };
}

describe("shader churn on recorded sessions", () => {
  const all = recordings();

  it("counts how often a shader node's cache key really changes", () => {
    expect(all.length).toBeGreaterThan(0);
    // Written to disk as well as logged: this config swallows console output, and a diagnostic whose
    // result is invisible is a diagnostic nobody will re-run.
    const report: string[] = [];
    const emit = (line: string): void => {
      report.push(line);
      console.log(line);
    };
    const grand = { nodes: 0, changed: 0, byComponent: {} as Record<string, number> };

    for (const rec of all) {
      const state = createMirrorState();
      // nodeId -> component -> set of distinct values
      const seen = new Map<string, Map<string, Set<string>>>();
      // nodeId -> component -> number of transitions (distinct-consecutive), which separates "changed twice"
      // from "changed every tick".
      const transitions = new Map<string, Map<string, number>>();
      const last = new Map<string, Record<string, string>>();

      let applied = 0;
      for (const raw of rec.messages) {
        let delta: ReturnType<typeof parseSceneDelta>;
        try {
          // `parseSceneDelta` takes the PARSED envelope, not the wire string — handing it the string
          // makes it return null for every message and the whole replay silently measures nothing.
          delta = parseSceneDelta(JSON.parse(raw));
        } catch {
          continue;
        }
        if (!delta) continue;
        applied++;
        try {
          applySceneDelta(state, delta);
        } catch {
          continue;
        }
        for (const node of state.nodes.values()) {
          if (!node.shaderId) continue;
          const parts = keyParts(node);
          let bucket = seen.get(node.id);
          if (!bucket) {
            bucket = new Map();
            seen.set(node.id, bucket);
            transitions.set(node.id, new Map());
          }
          const prev = last.get(node.id);
          const trans = transitions.get(node.id) as Map<string, number>;
          for (const [component, value] of Object.entries(parts)) {
            let set = bucket.get(component);
            if (!set) {
              set = new Set();
              bucket.set(component, set);
            }
            set.add(value);
            if (prev && prev[component] !== value) {
              trans.set(component, (trans.get(component) ?? 0) + 1);
            }
          }
          last.set(node.id, parts);
        }
      }

      // GUARD AGAINST A SILENT ZERO: a component that is null on every node shows "never changed", which is
      // indistinguishable from "stable" and would be read as proof of exactly the thing under test.
      let boxPopulated = 0;
      let transformPopulated = 0;
      for (const bucket of seen.values()) {
        const box = bucket.get("box");
        if (box && [...box].some((v) => v !== "")) boxPopulated++;
        const tf = bucket.get("transform");
        if (tf && [...tf].some((v) => v !== "")) transformPopulated++;
      }

      const nodes = seen.size;
      // WHICH shader, not just how many nodes. "6% of shader nodes churn" is not actionable; "these two
      // shader files churn and the rest never do" is, because the runtime's cache eligibility is per shader.
      const changedShaders = new Map<string, number>();
      const staticShaders = new Map<string, number>();
      let changed = 0;
      const byComponent: Record<string, { nodes: number; transitions: number }> = {};
      for (const [id, bucket] of seen) {
        let nodeChanged = false;
        for (const [component, set] of bucket) {
          if (set.size <= 1) continue;
          nodeChanged = true;
          byComponent[component] ??= { nodes: 0, transitions: 0 };
          byComponent[component].nodes++;
          byComponent[component].transitions += transitions.get(id)?.get(component) ?? 0;
        }
        const shader = [...(bucket.get("shaderId") ?? [])][0] ?? "?";
        const tally = nodeChanged ? changedShaders : staticShaders;
        tally.set(shader, (tally.get(shader) ?? 0) + 1);
        if (nodeChanged) changed++;
      }
      if (changedShaders.size) {
        for (const [shader, n] of [...changedShaders].sort((a, b) => b[1] - a[1])) {
          report.push(`      CHURNS  ${String(n).padStart(4)} nodes  ${shader}`);
        }
      }

      grand.nodes += nodes;
      grand.changed += changed;
      for (const [component, v] of Object.entries(byComponent)) {
        grand.byComponent[component] = (grand.byComponent[component] ?? 0) + v.nodes;
      }

      const pct = nodes ? ((changed / nodes) * 100).toFixed(1) : "0.0";
      // A recording that applied no deltas measured NOTHING, and a 0% churn line from it would read as
      // "shaders never change" — the exact conclusion this bench exists to test rather than assume.
      expect(applied).toBeGreaterThan(0);
      emit(
        `${rec.name.padEnd(46)} deltas=${String(applied).padStart(5)} shaderNodes=${String(nodes).padStart(4)}  ` +
          `boxPop=${String(boxPopulated).padStart(4)} tfPop=${String(transformPopulated).padStart(4)}  ` +
          `everChanged=${String(changed).padStart(4)} (${pct}%)  ` +
          Object.entries(byComponent)
            .map(([c, v]) => `${c}:${v.nodes}n/${v.transitions}t`)
            .join(" "),
      );
    }

    emit(
      `\nTOTAL shaderNodes=${grand.nodes} everChanged=${grand.changed} ` +
        `(${grand.nodes ? ((grand.changed / grand.nodes) * 100).toFixed(1) : "0"}%)  ` +
        Object.entries(grand.byComponent)
          .map(([c, n]) => `${c}:${n}`)
          .join(" "),
    );
    writeFileSync(resolve(process.cwd(), "../.sts2/shader-churn.txt"), `${report.join("\n")}\n`);
  }, 600_000);
});
