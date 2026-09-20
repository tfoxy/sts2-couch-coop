// Opt-in WebKit Inspector Heap-domain diagnostics. Raw heap data is deliberately
// kept out of returned summaries; callers retain it only in their ignored artifact root.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const WEBKIT_HEAP_DIAGNOSTICS_SCHEMA = "couchcoop-webkit-heap-diagnostics/1";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TOP = 25;
const CLASS_NAME_LIMIT = 200;

export class HeapDiagnosticsTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "HeapDiagnosticsTimeoutError";
  }
}

function timeoutMs(value) {
  const number = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(number) || number <= 0 || number > MAX_TIMEOUT_MS) {
    throw new RangeError(`Heap diagnostic timeout must be within 1..${MAX_TIMEOUT_MS}ms`);
  }
  return Math.floor(number);
}

function withTimeout(promise, label, milliseconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new HeapDiagnosticsTimeoutError(label, milliseconds)), milliseconds);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); rejectPromise(error); });
  });
}

function protocolCapability(error, method) {
  // The transport's planned ProtocolCommandError carries these protocol fields. Do not
  // classify arbitrary Error text as a capability result: target loss must stay fatal.
  const code = error?.code ?? error?.protocolCode;
  const reportedMethod = error?.method ?? error?.protocolMethod;
  const methodMatches = reportedMethod === method || reportedMethod === "Heap";
  const unsupported = code === -32601 || code === "MethodNotFound" || code === "DomainNotFound";
  if (!unsupported || !methodMatches) return null;
  return { method, code: typeof code === "number" || typeof code === "string" ? code : null };
}

function finite(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function safeClassName(value) { return String(value).slice(0, CLASS_NAME_LIMIT); }
function top(items, key, limit = MAX_TOP) {
  return items.sort((a, b) => b[key] - a[key] || String(a.className ?? "").localeCompare(String(b.className ?? "")) || (a.id ?? 0) - (b.id ?? 0)).slice(0, limit);
}

/**
 * Lazily negotiates WebKit's Heap domain. Constructing it does not send commands;
 * callers must explicitly request a GC or snapshot.
 */
export class WebKitHeapDiagnostics {
  #inspector;
  #outDir;
  #timeoutMs;
  #enabledTargetId = null;

  constructor({ inspector, outDir, timeoutMs: defaultTimeoutMs } = {}) {
    if (!inspector?.targetCommand || !inspector?.on || !inspector?.off) throw new TypeError("WebKitHeapDiagnostics requires an EventEmitter-like inspector");
    if (!outDir) throw new TypeError("WebKitHeapDiagnostics requires a caller-owned outDir");
    this.#inspector = inspector;
    this.#outDir = resolve(outDir);
    this.#timeoutMs = timeoutMs(defaultTimeoutMs);
  }

  async requestGc({ timeoutMs: requestedTimeoutMs } = {}) {
    const milliseconds = timeoutMs(requestedTimeoutMs ?? this.#timeoutMs);
    const enabled = await this.#enable(milliseconds);
    if (!enabled.supported) return enabled;
    const targetId = this.#activeTarget();
    const started = Date.now();
    let partialEvents = 0;
    let event = null;
    let settleEvent;
    const fullGc = new Promise((resolvePromise, rejectPromise) => { settleEvent = { resolve: resolvePromise, reject: rejectPromise }; });
    const failIfTargetChanged = () => {
      if (this.#inspector.targetId !== targetId) settleEvent.reject(new Error("WebKit target was replaced during Heap.gc"));
    };
    const onEvent = candidate => {
      if (candidate?.targetId !== targetId || candidate?.method !== "Heap.garbageCollected") return;
      const collection = candidate.params?.collection;
      if (collection?.type !== "full") { partialEvents = Math.min(partialEvents + 1, 100); return; }
      event = {
        type: "full", startTime: finite(collection.startTime), endTime: finite(collection.endTime),
        durationMs: finite(collection.startTime) !== null && finite(collection.endTime) !== null
          ? Math.max(0, Math.min(60_000, (collection.endTime - collection.startTime) * 1_000)) : null
      };
      settleEvent.resolve();
    };
    const onDestroyed = details => { if (details?.targetId === targetId) settleEvent.reject(new Error("WebKit target was lost during Heap.gc")); };
    this.#inspector.on("target-event", onEvent);
    this.#inspector.on("target", failIfTargetChanged);
    this.#inspector.on("target-destroyed", onDestroyed);
    try {
      // The listener is installed before Heap.gc, because WebKit may emit the event before
      // its command response reaches the nested target transport.
      const command = withTimeout(this.#inspector.targetCommand("Heap.gc", {}, milliseconds), "Heap.gc", milliseconds);
      // A structured unsupported response must also settle the event wait. Otherwise its
      // timeout remains referenced after the caller has already received the capability result.
      command.catch(error => settleEvent.reject(error));
      await Promise.all([
        command,
        withTimeout(fullGc, "Heap.garbageCollected(full)", milliseconds)
      ]);
      failIfTargetChanged();
      return {
        schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: true, method: "Heap.gc",
        elapsedMs: Math.min(60_000, Math.max(0, Date.now() - started)), partialEventCount: partialEvents, event
      };
    } catch (error) {
      const capability = protocolCapability(error, "Heap.gc");
      if (capability) return { schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: false, capability };
      throw error;
    } finally {
      this.#inspector.off("target-event", onEvent);
      this.#inspector.off("target", failIfTargetChanged);
      this.#inspector.off("target-destroyed", onDestroyed);
    }
  }

  async takeSnapshot({ label = "snapshot", index = 0, timeoutMs: requestedTimeoutMs } = {}) {
    const milliseconds = timeoutMs(requestedTimeoutMs ?? this.#timeoutMs);
    const enabled = await this.#enable(milliseconds);
    if (!enabled.supported) return enabled;
    const targetId = this.#activeTarget();
    let result;
    let rejectTargetChange;
    const targetChange = new Promise((_resolvePromise, rejectPromise) => { rejectTargetChange = rejectPromise; });
    const failIfTargetChanged = () => {
      if (this.#inspector.targetId !== targetId) rejectTargetChange(new Error("WebKit target was replaced during Heap.snapshot"));
    };
    const onDestroyed = details => { if (details?.targetId === targetId) rejectTargetChange(new Error("WebKit target was lost during Heap.snapshot")); };
    this.#inspector.on("target", failIfTargetChanged);
    this.#inspector.on("target-destroyed", onDestroyed);
    try {
      result = await withTimeout(Promise.race([
        this.#inspector.targetCommand("Heap.snapshot", {}, milliseconds), targetChange
      ]), "Heap.snapshot", milliseconds);
    } catch (error) {
      const capability = protocolCapability(error, "Heap.snapshot");
      if (capability) return { schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: false, capability };
      throw error;
    } finally {
      this.#inspector.off("target", failIfTargetChanged);
      this.#inspector.off("target-destroyed", onDestroyed);
    }
    if (this.#inspector.targetId !== targetId) throw new Error("WebKit target was replaced during Heap.snapshot");
    if (finite(result?.timestamp) === null || typeof result?.snapshotData !== "string") {
      throw new TypeError("Heap.snapshot returned an invalid timestamp or snapshotData");
    }
    const artifact = this.#writeSnapshot(result.snapshotData, label, index);
    return {
      schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: true, method: "Heap.snapshot", timestamp: result.timestamp,
      label: artifact.label, index: artifact.index, artifact: { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }
    };
  }

  async #enable(milliseconds) {
    const targetId = this.#activeTarget();
    if (this.#enabledTargetId === targetId) return { supported: true };
    try {
      await withTimeout(this.#inspector.targetCommand("Heap.enable", {}, milliseconds), "Heap.enable", milliseconds);
    } catch (error) {
      const capability = protocolCapability(error, "Heap.enable");
      if (capability) return { schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, supported: false, capability };
      throw error;
    }
    if (this.#inspector.targetId !== targetId) throw new Error("WebKit target was replaced during Heap.enable");
    this.#enabledTargetId = targetId;
    return { supported: true };
  }

  #activeTarget() {
    if (!this.#inspector.targetId || this.#inspector.closed) throw new Error("WebKit target is unavailable for Heap diagnostics");
    return this.#inspector.targetId;
  }

  #writeSnapshot(snapshotData, label, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) throw new RangeError("snapshot index must be a non-negative safe integer");
    const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "snapshot";
    mkdirSync(this.#outDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#outDir, 0o700);
    const filename = `heap-${String(index).padStart(3, "0")}-${safeLabel}.json`;
    const absolutePath = resolve(this.#outDir, filename);
    const artifactPath = relative(this.#outDir, absolutePath);
    if (!artifactPath || artifactPath.startsWith("..") || absolutePath === this.#outDir) throw new Error("snapshot artifact escaped its outDir");
    const bytes = Buffer.byteLength(snapshotData, "utf8");
    writeFileSync(absolutePath, snapshotData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(absolutePath, 0o600);
    return { label: safeLabel, index, path: artifactPath, bytes, sha256: createHash("sha256").update(snapshotData, "utf8").digest("hex") };
  }
}

function parseSnapshot(input) {
  let snapshot = input;
  if (typeof input === "string") {
    try { snapshot = JSON.parse(input); } catch { throw new TypeError("Heap snapshot is not valid JSON"); }
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("Heap snapshot must be an object");
  if (![1, 2, 3].includes(snapshot.version) || snapshot.type !== "Inspector") throw new TypeError("Unsupported Inspector heap snapshot version or type");
  const { nodes, edges, nodeClassNames, edgeTypes } = snapshot;
  if (!Array.isArray(nodes) || nodes.length < 4 || nodes.length % 4 || !Array.isArray(edges) || edges.length % 4 || !Array.isArray(nodeClassNames) || !Array.isArray(edgeTypes)) {
    throw new TypeError("Inspector heap snapshot has invalid flat node or edge tables");
  }
  const graphNodes = [];
  const byId = new Map();
  for (let offset = 0; offset < nodes.length; offset += 4) {
    const [id, shallowSize, classIndex, flags] = nodes.slice(offset, offset + 4);
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(shallowSize) || shallowSize < 0 || !Number.isSafeInteger(classIndex) || classIndex < 0 || typeof nodeClassNames[classIndex] !== "string" || !Number.isSafeInteger(flags) || flags < 0 || byId.has(id)) {
      throw new TypeError("Inspector heap snapshot contains an invalid node");
    }
    const node = { id, shallowSize, className: safeClassName(nodeClassNames[classIndex]), outgoing: [], incoming: [] };
    graphNodes.push(node); byId.set(id, node);
  }
  if (graphNodes[0].id !== 0) throw new TypeError("Inspector heap snapshot root must have id 0");
  for (let offset = 0; offset < edges.length; offset += 4) {
    const [fromId, toId, typeIndex, data] = edges.slice(offset, offset + 4);
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(toId) || !Number.isSafeInteger(typeIndex) || typeIndex < 0 || typeof edgeTypes[typeIndex] !== "string" || !Number.isSafeInteger(data) || !byId.has(fromId) || !byId.has(toId)) {
      throw new TypeError("Inspector heap snapshot contains an invalid edge");
    }
    const from = byId.get(fromId); const to = byId.get(toId);
    from.outgoing.push(to); to.incoming.push(from);
  }
  return { graphNodes, byId };
}

function buildDominators(graphNodes) {
  const root = graphNodes[0];
  const visited = new Set([root]); const postorder = []; const stack = [[root, 0]];
  while (stack.length) {
    const frame = stack.at(-1); const child = frame[0].outgoing[frame[1]++];
    if (child) { if (!visited.has(child)) { visited.add(child); stack.push([child, 0]); } }
    else { postorder.push(frame[0]); stack.pop(); }
  }
  const rpo = postorder.reverse();
  const order = new Map(rpo.map((node, index) => [node, index]));
  const idom = new Map([[root, root]]);
  const intersect = (first, second) => {
    let a = first; let b = second;
    while (a !== b) {
      while (order.get(a) > order.get(b)) a = idom.get(a);
      while (order.get(b) > order.get(a)) b = idom.get(b);
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo.slice(1)) {
      const predecessors = node.incoming.filter(predecessor => idom.has(predecessor));
      if (!predecessors.length) continue;
      let next = predecessors[0];
      for (const predecessor of predecessors.slice(1)) next = intersect(predecessor, next);
      if (idom.get(node) !== next) { idom.set(node, next); changed = true; }
    }
  }
  const retained = new Map(rpo.map(node => [node, node.shallowSize]));
  for (const node of [...rpo].reverse()) if (node !== root) retained.set(idom.get(node), retained.get(idom.get(node)) + retained.get(node));
  return { root, reachable: rpo, idom, retained };
}

/** Analyze the JavaScriptCore Inspector v1-v3 flat graph without exposing edge or value strings. */
function analyzeSnapshot(input, includeNodes = false) {
  const { graphNodes, byId } = parseSnapshot(input);
  const { root, reachable, idom, retained } = buildDominators(graphNodes);
  const classes = new Map();
  for (const node of graphNodes) {
    const value = classes.get(node.className) ?? { className: node.className, count: 0, shallowBytes: 0 };
    value.count++; value.shallowBytes += node.shallowSize; classes.set(node.className, value);
  }
  const dominators = top(reachable.filter(node => node !== root).map(node => ({
    id: node.id, className: node.className, shallowBytes: node.shallowSize, retainedBytes: retained.get(node), immediateDominatorId: idom.get(node).id
  })), "retainedBytes");
  const result = {
    schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, version: input?.version ?? (typeof input === "string" ? JSON.parse(input).version : null),
    totalShallowBytes: graphNodes.reduce((sum, node) => sum + node.shallowSize, 0), reachableShallowBytes: retained.get(root),
    nodeCount: graphNodes.length, reachableNodeCount: reachable.length, topClasses: top([...classes.values()], "shallowBytes"), topDominators: dominators
  };
  if (includeNodes) result.nodeMap = new Map(graphNodes.map(node => [node.id, {
    id: node.id, className: node.className, shallowBytes: node.shallowSize, retainedBytes: retained.get(node) ?? null,
    immediateDominatorId: idom.get(node)?.id ?? null, reachable: idom.has(node)
  }]));
  return result;
}

export function analyzeHeapSnapshot(input) {
  return analyzeSnapshot(input);
}

/** Diff node identities only after the caller has established both snapshots came from one persistent process. */
export function diffHeapSnapshots(initialInput, returnInput, { persistentProcess = false } = {}) {
  if (!persistentProcess) throw new Error("Heap snapshot identity diff requires persistentProcess: true");
  const initial = analyzeSnapshot(initialInput, true); const returned = analyzeSnapshot(returnInput, true);
  const classDeltas = new Map();
  const addClass = (className, bytes) => classDeltas.set(className, (classDeltas.get(className) ?? 0) + bytes);
  for (const node of initial.nodeMap.values()) addClass(node.className, -node.shallowBytes);
  for (const node of returned.nodeMap.values()) addClass(node.className, node.shallowBytes);
  const added = []; const removed = []; const retainedDeltas = [];
  for (const [id, node] of returned.nodeMap) {
    const previous = initial.nodeMap.get(id);
    if (!previous) { added.push(node); continue; }
    // Root retained size is represented once below. Including it in the ranked nodes
    // would make a reader treat the same graph-wide delta as an additional owner.
    if (id !== 0 && node.reachable && previous.reachable) retainedDeltas.push({ id, className: node.className, deltaBytes: node.retainedBytes - previous.retainedBytes });
  }
  for (const [id, node] of initial.nodeMap) if (!returned.nodeMap.has(id)) removed.push(node);
  const deltaList = [...classDeltas].filter(([, deltaBytes]) => deltaBytes !== 0).map(([className, deltaBytes]) => ({ className, deltaBytes }));
  const signed = values => values.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes) || a.className.localeCompare(b.className)).slice(0, MAX_TOP);
  const retainedSigned = values => values.filter(value => value.deltaBytes !== 0).sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes) || a.id - b.id).slice(0, MAX_TOP);
  return {
    schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, persistentProcess: true,
    totalShallowDeltaBytes: returned.totalShallowBytes - initial.totalShallowBytes,
    // This is the one aggregate retained value; summing per-node retained deltas would double count dominator subtrees.
    rootRetainedDeltaBytes: returned.reachableShallowBytes - initial.reachableShallowBytes,
    newNodes: { count: added.length, shallowBytes: added.reduce((sum, node) => sum + node.shallowBytes, 0) },
    removedNodes: { count: removed.length, shallowBytes: removed.reduce((sum, node) => sum + node.shallowBytes, 0) },
    positiveShallowClassDeltas: signed(deltaList.filter(value => value.deltaBytes > 0)),
    negativeShallowClassDeltas: signed(deltaList.filter(value => value.deltaBytes < 0)),
    positiveRetainedSizeDeltas: retainedSigned(retainedDeltas.filter(value => value.deltaBytes > 0)),
    negativeRetainedSizeDeltas: retainedSigned(retainedDeltas.filter(value => value.deltaBytes < 0))
  };
}
