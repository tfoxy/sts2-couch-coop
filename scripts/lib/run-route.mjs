// A DECLARATIVE SESSION ROUTE — the "what happens, and for how long" half of scripts/run-session-soak.mjs.
//
// A route is a JSON document:
//
//   {
//     "schema": "couchcoop-session-route/1",
//     "name": "act1-to-act2",
//     "steps": [
//       { "kind": "mark",        "label": "embarked" },
//       { "kind": "dev-console", "label": "fight-1", "args": ["room", "MONSTER"], "dwellSeconds": 240 },
//       { "kind": "dev-console", "label": "win-1",   "args": ["win"] },
//       { "kind": "fetch",       "label": "spine-1", "args": { "path": "/perf/spine.json" } },
//       { "kind": "wait",        "label": "settle",  "dwellSeconds": 60 }
//     ]
//   }
//
// Step kinds:
//   dev-console  `args` = [command, ...commandArgs], passed to the game's own developer console through the
//                `sts2 dev console` path against the HOST's bridge. Then dwell `dwellSeconds`.
//   wait         dwell `dwellSeconds`; nothing else.
//   mark         a labelled timestamp in the stream (optional `data` object); dwell if `dwellSeconds` is given.
//   fetch        GET `args.path` from the host's browser server and save the body; then dwell.
//   real-input   RESERVED for the full-run E2E, where a viewer's step becomes the same hover/press/release a
//                player produces. Validated for shape only; `runRoute` refuses it unless the caller injects an
//                `executors.realInput`, and nothing in this repo injects one yet (see REAL_INPUT_CONTRACT).
//
// Every step emits a `route` record with `event` "start", then "acted" when its action completes, then "end" when its
// dwell ends ("failed" instead, when it stops the route), so the sampler stream can be cut into per-step windows
// after the fact. (`event`, not `phase`: the session stream stamps its own `phase` on every record.)
//
// EXTRA KINDS. A caller may register its own step kinds (`extraKinds` for validation, `executors[kind]` to run
// them) — the way a round's research glue adds a control-file toggle or a background recorder without forking this
// file. An extra kind may not shadow a built-in one.
//
// SAFETY. This file never sends input. The dev-console kind refuses the console commands the `sts2` CLI itself
// classes as persisted-file mutations (achievement / cloud / unlock) even though the CLI would also refuse them in
// normal mode: a route file is data, and data should not be one flag away from touching a Steam cloud store.

/** Schema id of a route document. */
export const ROUTE_SCHEMA = "couchcoop-session-route/1";

export const STEP_KINDS = Object.freeze(["dev-console", "wait", "mark", "fetch", "real-input"]);

/** Console commands the `sts2` CLI gates behind `--mode dangerous` because they mutate persisted files. */
export const REFUSED_CONSOLE_COMMANDS = Object.freeze(["achievement", "cloud", "unlock"]);

/**
 * The interface a future real-input executor must satisfy. Written down now so the E2E can be built against it
 * without re-deriving it:
 *
 *   executors.realInput(step, context) -> Promise<{ ok: boolean, detail?: string, evidence?: string[] }>
 *
 *   - `step.args` is the executor's own vocabulary (e.g. `{ seat: "Ann", target: "<stable id>", gesture: "tap" }`).
 *     Prefer stable ids to coordinates; the executor resolves the coordinate at run time.
 *   - It MUST look before it acts: capture the seat's current view (screenshot or scene read) and refuse when the
 *     expected target is not on screen. It must hover before it presses. No blind input — ever.
 *   - It drives a VIEWER's page (the browser seat), which replays real input into the game. It must not call a
 *     spirectl semantic action to commit a player's choice.
 *   - It returns evidence paths; a visual claim without an image path is not evidence.
 *
 * TODO(full-run E2E): implement this against the seat pages that scripts/probe-five-player-run.mjs `seatPages()`
 * exposes, and add a self-test that proves it refuses an absent target.
 */
export const REAL_INPUT_CONTRACT = "executors.realInput(step, context) -> Promise<{ok, detail?, evidence?}>";

export class RouteError extends Error {
  name = "RouteError";
}

const COMMAND_PATTERN = /^[a-z_][a-z0-9_]*$/i;

function validateStep(raw, index, { allowRealInput, extraKinds }) {
  const where = `step ${index}${raw?.label ? ` (${raw.label})` : ""}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RouteError(`${where}: must be an object`);
  const known = new Set(["kind", "label", "args", "dwellSeconds", "onError", "data"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new RouteError(`${where}: unknown field ${JSON.stringify(key)}`);
  }
  const extra = Object.hasOwn(extraKinds, raw.kind) ? extraKinds[raw.kind] : null;
  if (!STEP_KINDS.includes(raw.kind) && !extra) {
    throw new RouteError(`${where}: kind must be one of ${[...STEP_KINDS, ...Object.keys(extraKinds)].join(", ")}; got ${JSON.stringify(raw.kind)}`);
  }
  const label = raw.label ?? `${raw.kind}-${index}`;
  if (typeof label !== "string" || label.length === 0 || /[\s/\\]/.test(label)) {
    throw new RouteError(`${where}: label must be a non-empty string with no whitespace or path separators`);
  }
  const dwellSeconds = raw.dwellSeconds ?? 0;
  if (typeof dwellSeconds !== "number" || !Number.isFinite(dwellSeconds) || dwellSeconds < 0) {
    throw new RouteError(`${where}: dwellSeconds must be a finite number >= 0`);
  }
  if (raw.kind === "wait" && dwellSeconds === 0) throw new RouteError(`${where}: a wait step needs dwellSeconds > 0`);
  const onError = raw.onError ?? "abort";
  if (onError !== "abort" && onError !== "continue") throw new RouteError(`${where}: onError must be "abort" or "continue"`);
  if (raw.data !== undefined && (raw.kind !== "mark" || typeof raw.data !== "object" || raw.data === null || Array.isArray(raw.data))) {
    throw new RouteError(`${where}: data is only allowed on a mark step, as an object`);
  }

  let args = raw.args ?? null;
  if (extra) {
    // The extra kind owns its args; it throws (a RouteError, ideally) on anything it will not run.
    args = extra.validate(args, where) ?? args;
    return { index, kind: raw.kind, label, args, dwellSeconds, onError, ...(raw.data ? { data: raw.data } : {}) };
  }
  switch (raw.kind) {
    case "dev-console": {
      if (!Array.isArray(args) || args.length === 0 || !args.every(arg => typeof arg === "string" && arg.length > 0 && !/[\0\n\r]/.test(arg))) {
        throw new RouteError(`${where}: dev-console args must be a non-empty array of single-line strings, command first`);
      }
      const command = args[0].trim().toLowerCase();
      if (!COMMAND_PATTERN.test(command)) throw new RouteError(`${where}: ${JSON.stringify(args[0])} is not a console command name`);
      if (REFUSED_CONSOLE_COMMANDS.includes(command)) {
        throw new RouteError(`${where}: console command "${command}" mutates persisted files (the CLI gates it behind --mode dangerous); a soak route may not use it`);
      }
      args = [command, ...args.slice(1)];
      break;
    }
    case "fetch": {
      const target = args?.path;
      if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || /[\s#]/.test(target)) {
        throw new RouteError(`${where}: fetch needs args.path, an absolute path on the host's browser server (e.g. "/perf/spine.json")`);
      }
      args = { path: target };
      break;
    }
    case "real-input": {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new RouteError(`${where}: real-input args must be an object`);
      if (!allowRealInput) {
        throw new RouteError(`${where}: real-input steps are reserved for the full-run E2E and have no executor yet (${REAL_INPUT_CONTRACT})`);
      }
      break;
    }
    default:
      if (args !== null) throw new RouteError(`${where}: a ${raw.kind} step takes no args`);
  }
  return { index, kind: raw.kind, label, args, dwellSeconds, onError, ...(raw.data ? { data: raw.data } : {}) };
}

/**
 * Validates and normalizes a route. `allowRealInput` is true only when the caller has a real-input executor; the
 * CLI in this repo never passes it, so a route with real-input steps is refused before anything launches.
 */
export function validateRoute(route, { allowRealInput = false, extraKinds = {} } = {}) {
  for (const kind of Object.keys(extraKinds)) {
    if (STEP_KINDS.includes(kind)) throw new RouteError(`extra step kind "${kind}" would shadow a built-in one`);
    if (typeof extraKinds[kind]?.validate !== "function") throw new RouteError(`extra step kind "${kind}" needs a validate(args, where) function`);
  }
  if (!route || typeof route !== "object" || Array.isArray(route)) throw new RouteError("a route must be a JSON object");
  if (route.schema !== ROUTE_SCHEMA) {
    throw new RouteError(`route schema must be "${ROUTE_SCHEMA}"; got ${JSON.stringify(route.schema ?? null)}`);
  }
  if (typeof route.name !== "string" || route.name.length === 0) throw new RouteError("route.name must be a non-empty string");
  if (!Array.isArray(route.steps) || route.steps.length === 0) throw new RouteError("route.steps must be a non-empty array");
  const steps = route.steps.map((step, index) => validateStep(step, index, { allowRealInput, extraKinds }));
  const labels = new Set();
  for (const step of steps) {
    if (labels.has(step.label)) throw new RouteError(`step ${step.index}: duplicate label ${JSON.stringify(step.label)}`);
    labels.add(step.label);
  }
  return { schema: ROUTE_SCHEMA, name: route.name, ...(route.description ? { description: String(route.description) } : {}), steps };
}

export function parseRoute(text, options) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RouteError(`route is not JSON: ${error.message}`);
  }
  return validateRoute(value, options);
}

/** The route as a timeline of planned offsets. Action time is unknown in advance, so offsets count dwell only. */
export function planRoute(route) {
  let offset = 0;
  const timeline = route.steps.map(step => {
    const entry = {
      index: step.index,
      label: step.label,
      kind: step.kind,
      startOffsetSeconds: offset,
      dwellSeconds: step.dwellSeconds,
      action: step.kind === "dev-console" ? `dev console ${step.args.join(" ")}` : step.kind === "fetch" ? `GET ${step.args.path}` : null
    };
    offset += step.dwellSeconds;
    return entry;
  });
  return { name: route.name, steps: timeline, totalDwellSeconds: offset };
}

/** An abortable sleep. Resolves early (without throwing) when `signal` aborts. */
export function abortableSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs a validated route. Nothing here knows about games or browsers: every side effect goes through `executors`.
 *
 *   executors.devConsole(args, step)  -> {ok, exitCode?, response?, error?}
 *   executors.fetch(args, step)       -> {ok, status?, bytes?, savedTo?, error?}
 *   executors.realInput(step, ctx)    -> {ok, detail?, evidence?}   (see REAL_INPUT_CONTRACT)
 *   executors[<extra kind>](args, step, {signal}) -> {ok, ...}       (see EXTRA KINDS above)
 *   emit(record)                      -> writes a stream record ({kind: "route" | "mark", ...})
 *
 * Returns `{completed, aborted, failedStep, steps: [...]}`. A failing step with `onError: "abort"` stops the
 * route; an aborted `signal` stops it at the next boundary (a dwell ends immediately).
 */
export async function runRoute(route, { executors = {}, emit = () => {}, sleep = abortableSleep, now = () => Date.now(), signal = null } = {}) {
  const results = [];
  let failedStep = null;
  for (const step of route.steps) {
    if (signal?.aborted) break;
    if (step.kind === "real-input" && typeof executors.realInput !== "function") {
      throw new RouteError(`step ${step.index} (${step.label}): no real-input executor was provided (${REAL_INPUT_CONTRACT})`);
    }
    const startedAt = now();
    const base = { kind: "route", stepIndex: step.index, label: step.label, stepKind: step.kind };
    emit({ ...base, event: "start", args: step.args ?? null, dwellSeconds: step.dwellSeconds });

    let outcome = { ok: true };
    try {
      switch (step.kind) {
        case "dev-console": outcome = await executors.devConsole(step.args, step); break;
        case "fetch": outcome = await executors.fetch(step.args, step); break;
        case "real-input": outcome = await executors.realInput(step, { signal }); break;
        case "mark": emit({ kind: "mark", label: step.label, ...(step.data ? { data: step.data } : {}) }); break;
        case "wait": break; // the dwell is the step
        default:
          if (typeof executors[step.kind] !== "function") throw new RouteError(`no executor for step kind "${step.kind}"`);
          outcome = await executors[step.kind](step.args, step, { signal });
      }
    } catch (error) {
      outcome = { ok: false, error: error?.message ?? String(error) };
    }
    const actedAt = now();
    const ok = outcome?.ok === true;
    emit({ ...base, event: "acted", ok, actionMs: actedAt - startedAt, outcome: compactOutcome(outcome) });

    const record = { index: step.index, label: step.label, kind: step.kind, ok, startedAt, actedAt, endedAt: null, outcome: compactOutcome(outcome) };
    results.push(record);
    if (!ok && step.onError === "abort") {
      failedStep = { index: step.index, label: step.label, error: outcome?.error ?? outcome?.detail ?? "step reported ok:false" };
      record.endedAt = actedAt;
      emit({ ...base, event: "failed", error: failedStep.error });
      break;
    }

    await sleep(step.dwellSeconds * 1000, signal);
    record.endedAt = now();
    emit({ ...base, event: "end", dwellMs: record.endedAt - actedAt, interrupted: Boolean(signal?.aborted) });
  }
  const aborted = Boolean(signal?.aborted);
  return {
    completed: !aborted && failedStep === null && results.length === route.steps.length,
    aborted,
    failedStep,
    steps: results
  };
}

function compactOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return null;
  const text = JSON.stringify(outcome);
  return text.length <= 2000 ? outcome : { ok: outcome.ok ?? null, truncated: true, preview: text.slice(0, 1000) };
}
