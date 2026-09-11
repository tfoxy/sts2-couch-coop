// Reads the mirror wire directly — no browser, no dev server — and reports what every SPINE node is
// currently animating and which PARTICLE nodes claim to be emitting.
//
// Why this exists: two whole classes of "the mirror paints something the game is not showing" are decided
// entirely on the wire, and both are invisible to a screenshot until you already know where to look:
//   * a spine node whose `spineCurrentAnim` is a clip the game never applied (the producer GUESSED it) —
//     the still lane then bakes the MIDDLE of that clip and parks it forever (the Regent's daggers);
//   * a one-shot particle node whose `particleEmitting` latched `true` (a headless visual freeze disables
//     the `_process` Godot clears `Emitting` from) — the browser's static particle mode then parks a warmed
//     burst forever (the Regent energy counter's ring).
// Both read as a single stuck field on a single node, so assert them here rather than by eye.
//
// It is a PURE READ: it opens the mirror page, never joins a seat, never pushes a `settings` payload, and
// never sends input — so it is safe against a live host as well as an isolated instance.
//
// Usage:
//   node scripts/probe-mirror-spine-particles.mjs                       # port 13337, 8s
//   node scripts/probe-mirror-spine-particles.mjs --port 13437 --duration 12
//   node scripts/probe-mirror-spine-particles.mjs --port 13437 --scene regent --json
//
// Flags:
//   --port <n>       mirror HTTP port (default 13337; a headless couch seat is 13347/13357/…)
//   --duration <s>   how long to accumulate deltas before reporting (default 8)
//   --scene <sub>    only report nodes whose sceneFilePath/name/nodeType contains <sub> (case-insensitive)
//   --emitting       particle section lists ONLY nodes with particleEmitting true
//   --json           machine-readable dump instead of the text report

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const port = flag("port", "13337");
const durationMs = Number(flag("duration", "8")) * 1000;
const sceneFilter = (flag("scene", "") || "").toLowerCase();
const emittingOnly = has("emitting");
const asJson = has("json");

// The scene stream is a delta stream: a non-`full` frame carries only the nodes that changed, and each
// upsert carries only the CHANGED fields. Merging shallowly would drop a sibling field that a later partial
// upsert did not restate, so fold objects recursively; `null` is a real "cleared" value and overwrites.
const merge = (into, from) => {
  for (const [key, value] of Object.entries(from)) {
    if (value && typeof value === "object" && !Array.isArray(value) && into[key] && typeof into[key] === "object" && !Array.isArray(into[key])) {
      merge(into[key], value);
    } else {
      into[key] = value;
    }
  }
  return into;
};

const nodes = new Map();
let frames = 0;
let fullFrames = 0;
let screenType = null;

// This is a wire-only observer, not a trail renderer, so it explicitly declares trailDrive=0.
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0`);
ws.onerror = (event) => {
  console.error(`[probe] websocket error against 127.0.0.1:${port}: ${event?.message ?? event}`);
  process.exitCode = 2;
};
ws.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type !== "scene-delta") return;
  frames += 1;
  if (message.full) {
    // A `full` keyframe re-states the whole tree; anything held from before it is stale by definition.
    fullFrames += 1;
    nodes.clear();
  }
  if (message.screenType) screenType = message.screenType;
  for (const upsert of message.upserts ?? []) {
    const existing = nodes.get(upsert.id);
    nodes.set(upsert.id, existing ? merge(existing, upsert) : { ...upsert });
  }
  for (const id of message.removedIds ?? []) nodes.delete(id);
};

const nodePath = (node) => {
  const parts = [];
  let current = node;
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    parts.unshift(current.name ?? "?");
    current = current.parentId ? nodes.get(current.parentId) : null;
  }
  return parts.join("/");
};

// The producer only stamps `sceneFilePath` on nodes that ARE a scene root, so a leaf's owning scene is the
// nearest such ancestor — which is the name a .tscn defect is reported against (regent.tscn, …).
const owningScene = (node) => {
  let current = node;
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.sceneFilePath) return current.sceneFilePath.split("/").at(-1);
    current = current.parentId ? nodes.get(current.parentId) : null;
  }
  return "";
};

const matchesFilter = (node) => {
  if (!sceneFilter) return true;
  const haystack = `${owningScene(node)} ${nodePath(node)} ${node.nodeType ?? ""}`.toLowerCase();
  return haystack.includes(sceneFilter);
};

setTimeout(() => {
  try {
    ws.close();
  } catch {
    /* already closed */
  }

  const all = [...nodes.values()];
  // A spine node is one the producer decided to describe as spine — `spineAtlas`/`spineSkeleton` are present
  // even when the animation is NULL, which is exactly the case this probe has to be able to see. Keying off
  // `spineCurrentAnim` alone would make a blanked node invisible instead of visibly blank.
  const spine = all
    .filter((node) => Object.keys(node).some((key) => key.startsWith("spine")))
    .filter(matchesFilter)
    .map((node) => ({
      id: node.id,
      name: node.name,
      scene: owningScene(node),
      path: nodePath(node),
      anim: node.spineCurrentAnim ?? null,
      looping: node.spineLooping ?? null,
      trackTime: node.spineTrackTime ?? null,
      stillTime: node.spineStillTime ?? null,
      skeleton: node.spineSkeleton ?? node.spineSkeletonPath ?? null,
    }));

  const particles = all
    .filter((node) => Object.keys(node).some((key) => key.startsWith("particle")))
    .filter(matchesFilter)
    .filter((node) => !emittingOnly || node.particleEmitting === true)
    .map((node) => ({
      id: node.id,
      name: node.name,
      scene: owningScene(node),
      path: nodePath(node),
      emitting: node.particleEmitting ?? false,
      oneShot: node.particleOneShot ?? null,
      lifetime: node.particleLifetime ?? null,
      explosiveness: node.particleExplosiveness ?? null,
    }));

  if (asJson) {
    console.log(JSON.stringify({ port, screenType, frames, fullFrames, nodeCount: nodes.size, spine, particles }, null, 2));
    process.exit(0);
  }

  console.log(`# mirror :${port} — screen=${screenType} nodes=${nodes.size} deltaFrames=${frames} (${fullFrames} full)`);
  console.log(`\n## spine nodes (${spine.length})`);
  for (const row of spine.sort((a, b) => `${a.scene}${a.path}`.localeCompare(`${b.scene}${b.path}`))) {
    const anim = row.anim === null ? "— NONE —" : `"${row.anim}"`;
    const extra = [
      row.looping === null ? null : `loop=${row.looping}`,
      row.trackTime === null ? null : `t=${row.trackTime}`,
      row.stillTime === null || row.stillTime === undefined ? null : `still=${row.stillTime}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`  ${row.scene.padEnd(28)} ${row.path.padEnd(58)} ${anim}${extra ? ` ${extra}` : ""}`);
  }

  const emitting = particles.filter((row) => row.emitting);
  console.log(`\n## particle nodes (${particles.length}, ${emitting.length} EMITTING)`);
  for (const row of particles.sort((a, b) => `${a.scene}${a.path}`.localeCompare(`${b.scene}${b.path}`))) {
    console.log(
      `  ${row.emitting ? "EMIT" : "  . "} ${row.scene.padEnd(28)} ${row.path.padEnd(70)}` +
        `${row.oneShot === null ? "" : ` oneShot=${row.oneShot}`}${row.lifetime === null ? "" : ` life=${row.lifetime}`}`,
    );
  }
  process.exit(0);
}, durationMs);
