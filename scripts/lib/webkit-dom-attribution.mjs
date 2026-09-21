import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const WEBKIT_DOM_ATTRIBUTION_SCHEMA = "couchcoop-webkit-dom-attribution/1";

export function attributes(node) {
  const values = {};
  for (let index = 0; index < (node?.attributes?.length ?? 0); index += 2) values[node.attributes[index]] = node.attributes[index + 1];
  return values;
}

export function flattenDocument(root) {
  const nodes = new Map();
  const visit = (node, parentNodeId = null) => {
    if (!node || !Number.isInteger(node.nodeId)) return;
    nodes.set(node.nodeId, {
      nodeId: node.nodeId, parentNodeId, nodeName: node.nodeName ?? null, localName: node.localName ?? null,
      nodeValue: node.nodeValue ?? null, attributes: attributes(node)
    });
    for (const child of node.children ?? []) visit(child, node.nodeId);
    for (const child of node.shadowRoots ?? []) visit(child, node.nodeId);
    if (node.contentDocument) visit(node.contentDocument, node.nodeId);
  };
  visit(root);
  return nodes;
}

export function joinLayersWithNodes(layers, nodes) {
  const byId = nodes instanceof Map ? nodes : new Map((nodes ?? []).map(node => [node.nodeId, node]));
  return (layers ?? []).map(layer => ({
    layerId: layer.layerId ?? null,
    nodeId: Number.isInteger(layer.nodeId) ? layer.nodeId : null,
    memoryBytes: Number.isFinite(layer.memory) ? layer.memory : 0,
    bounds: { x: layer.bounds?.x ?? null, y: layer.bounds?.y ?? null, width: layer.bounds?.width ?? null, height: layer.bounds?.height ?? null },
    node: Number.isInteger(layer.nodeId) ? byId.get(layer.nodeId) ?? null : null
  }));
}

export function loadInitAssignments({ inline = null, file = null } = {}) {
  if (inline !== null && file !== null) throw new Error("choose only one of --init-json or --init-json-file");
  const source = file !== null ? readFileSync(file, "utf8") : inline;
  if (source === null) return { assignments: {}, sourceKind: "none", sourcePath: null, sha256: null, bytes: 0 };
  let assignments;
  try { assignments = JSON.parse(source); }
  catch (error) { throw new Error(`invalid init JSON: ${error.message}`); }
  if (!assignments || Array.isArray(assignments) || typeof assignments !== "object") throw new Error("init JSON must be an object of global assignments");
  for (const name of Object.keys(assignments)) if (!/^__[A-Za-z0-9_$]+$/.test(name)) throw new Error(`unsafe init global name ${JSON.stringify(name)}`);
  return {
    assignments, sourceKind: file !== null ? "file" : "inline", sourcePath: file,
    sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source)
  };
}

export function bootstrapScript(assignments) {
  const json = JSON.stringify(assignments).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `(() => { const values = ${json}; for (const name of Object.keys(values)) Object.defineProperty(globalThis, name, { value: values[name], writable: true, configurable: true }); globalThis.__couchCoopProbeInitReceipt = { names: Object.keys(values).sort(), values }; })();`;
}

async function describeNode(inspector, nodeId, timeoutMs) {
  try {
    const resolved = await inspector.targetCommand("DOM.resolveNode", { nodeId }, timeoutMs);
    const objectId = resolved.object?.objectId;
    if (!objectId) return { nodeId, error: "DOM.resolveNode returned no object id" };
    try {
      const called = await inspector.targetCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const describe = node => {
            if (!node || node.nodeType !== 1) return null;
            const attrs = Object.fromEntries([...node.attributes].map(a => [a.name, a.value]));
            const rect = node.getBoundingClientRect();
            return { tag: node.localName, id: node.id || null, classes: [...node.classList], attrs,
              css: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              backing: node instanceof HTMLCanvasElement ? { width: node.width, height: node.height } : null };
          };
          const ancestry = []; for (let node = this; node && ancestry.length < 24; node = node.parentElement) ancestry.push(describe(node));
          return { self: ancestry[0] ?? null, ancestry };
        }`,
        returnByValue: true
      }, timeoutMs);
      return { nodeId, ...(called.result?.value ?? { error: "node description returned no value" }) };
    } finally {
      await inspector.targetCommand("Runtime.releaseObject", { objectId }, timeoutMs).catch(() => {});
    }
  } catch (error) { return { nodeId, error: error.message }; }
}

export async function captureDomAndLayers(inspector, timeoutMs = 10_000) {
  await inspector.targetCommand("LayerTree.enable", {}, timeoutMs);
  const document = await inspector.targetCommand("DOM.getDocument", { depth: -1 }, timeoutMs);
  const layerResponse = await inspector.targetCommand("LayerTree.layersForNode", { nodeId: document.root.nodeId }, timeoutMs);
  const nodes = flattenDocument(document.root);
  const interesting = new Set((layerResponse.layers ?? []).map(layer => layer.nodeId).filter(Number.isInteger));
  const selectors = ["[data-godot-particle-canvas]", "[data-godot-shader-canvas]", "canvas", "img"];
  const selectorNodeIds = {};
  for (const selector of selectors) {
    const queried = await inspector.targetCommand("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector }, timeoutMs);
    selectorNodeIds[selector] = queried.nodeIds ?? [];
    for (const nodeId of selectorNodeIds[selector]) interesting.add(nodeId);
  }
  const descriptions = [];
  for (const nodeId of interesting) descriptions.push(await describeNode(inspector, nodeId, timeoutMs));
  for (const description of descriptions) {
    const node = nodes.get(description.nodeId) ?? { nodeId: description.nodeId, parentNodeId: null, nodeName: null, localName: null, nodeValue: null, attributes: {} };
    node.description = description;
    nodes.set(description.nodeId, node);
  }
  const layers = layerResponse.layers ?? [];
  return {
    schema: WEBKIT_DOM_ATTRIBUTION_SCHEMA,
    rootNodeId: document.root.nodeId,
    selectorNodeIds,
    nodes: [...nodes.values()],
    layers: layerResponse,
    layerAttribution: joinLayersWithNodes(layers, nodes)
  };
}

// DOM.getDocument refreshes WebKit's frontend node-id map. A second capture that calls it while the first is
// still using its root id makes the first capture fail in LayerTree.layersForNode/querySelectorAll. Keep the
// complete DOM + LayerTree transaction exclusive for each Capture/inspector, including failure cleanup, so a
// mark and the continuous sampler cannot invalidate one another's ids.
export class SerializedDomLayerCapture {
  constructor(inspector, timeoutMs = 10_000) {
    this.inspector = inspector;
    this.timeoutMs = timeoutMs;
    this.tail = Promise.resolve();
  }

  capture() {
    const predecessor = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    return (async () => {
      await predecessor;
      try {
        return await captureDomAndLayers(this.inspector, this.timeoutMs);
      } finally {
        release();
      }
    })();
  }
}

export async function pageDiagnostics(inspector, timeoutMs = 10_000) {
  const result = await inspector.targetCommand("Runtime.evaluate", {
    expression: `(() => {
      const stage = document.querySelector("[data-stage], #stage, .mirror-stage") || document.documentElement;
      const params = Object.fromEntries(new URL(location.href).searchParams);
      const canvases = [...document.querySelectorAll("canvas")].map((canvas, index) => {
        const rect = canvas.getBoundingClientRect();
        return { index, attrs: Object.fromEntries([...canvas.attributes].map(a => [a.name, a.value])),
          css: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          backing: { width: canvas.width, height: canvas.height } };
      });
      let ablation = { available: false, receipt: null, error: null };
      try { if (typeof globalThis.__mirrorSceneAblationReceipt === "function") ablation = { available: true, receipt: globalThis.__mirrorSceneAblationReceipt(), error: null }; }
      catch (error) { ablation = { available: true, receipt: null, error: String(error && error.message || error) }; }
      return JSON.stringify({
        url: location.href, params, title: document.title, readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        initReceipt: globalThis.__couchCoopProbeInitReceipt ?? null,
        ablation,
        stage: { transform: getComputedStyle(stage).transform,
          mirrorLayoutScale: getComputedStyle(stage).getPropertyValue("--mirror-layout-scale").trim() || null },
        canvases,
        markerCounts: {
          particle: document.querySelectorAll("[data-godot-particle-canvas]").length,
          shader: document.querySelectorAll("[data-godot-shader-canvas]").length
        }
      });
    })()`,
    returnByValue: true
  }, timeoutMs);
  return JSON.parse(result.result?.value ?? "null");
}
