import { createHash } from "node:crypto";

export const WEBKIT_NETWORK_EVIDENCE_SCHEMA = "couchcoop-webkit-network-evidence/1";
const MAX_OUTGOING_PAYLOAD_BYTES = 64 * 1024;

const digest = value => createHash("sha256").update(value).digest("hex");
const byteLength = value => Buffer.byteLength(value, "utf8");

function assetKind(url) {
  try {
    const pathname = new URL(url).pathname;
    for (const prefix of ["/res/", "/bg/", "/spines/", "/geoclips/"]) if (pathname.startsWith(prefix)) return prefix.slice(1, -1);
  } catch { /* retain an invalid URL as non-asset evidence */ }
  return null;
}

function jsonEnvelope(payload) {
  if (byteLength(payload) > MAX_OUTGOING_PAYLOAD_BYTES) {
    const type = /"type"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(payload)?.[1] ?? null;
    const revisionText = /"revision"\s*:\s*(\d+)/.exec(payload)?.[1] ?? null;
    return { type, revision: revisionText === null ? null : Number(revisionText), keys: null, boundedWithoutParse: true };
  }
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") return null;
    const summary = {};
    for (const name of ["type", "command", "kind", "revision", "screen", "watch", "staticBg", "cardFlight", "handTween", "trailDrive"]) {
      if (["string", "number", "boolean"].includes(typeof value[name]) || value[name] === null) summary[name] = value[name];
    }
    summary.keys = Object.keys(value).sort();
    return summary;
  } catch { return null; }
}

export function webSocketFrameReceipt(direction, params) {
  const frame = params?.response ?? {};
  const payload = typeof frame.payloadData === "string" ? frame.payloadData : "";
  const bytes = byteLength(payload);
  return {
    requestId: params?.requestId ?? null, direction, timestamp: params?.timestamp ?? null,
    opcode: frame.opcode ?? null, mask: frame.mask ?? null, bytes, sha256: digest(payload),
    json: jsonEnvelope(payload),
    ...(direction === "sent" && bytes <= MAX_OUTGOING_PAYLOAD_BYTES ? { payload } : { payloadOmitted: true })
  };
}

export class WebKitNetworkEvidence {
  constructor({ record = () => {} } = {}) {
    this.record = record;
    this.status = "not-enabled";
    this.error = null;
    this.requests = new Map();
    this.webSockets = new Map();
    this.frames = [];
    this.eventCount = 0;
  }

  async enable(inspector, timeoutMs) {
    try {
      await inspector.targetCommand("Network.enable", {}, timeoutMs);
      this.status = "enabled"; this.error = null;
      this.record("network-status", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, status: this.status, targetId: inspector.targetId });
      return true;
    } catch (error) {
      this.status = "unsupported"; this.error = error.message;
      this.record("network-status", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, status: this.status, error: error.message, targetId: inspector.targetId });
      return false;
    }
  }

  accept(event) {
    if (!event?.method?.startsWith("Network.")) return false;
    this.eventCount++;
    const method = event.method.slice("Network.".length);
    const params = event.params ?? {};
    if (method === "requestWillBeSent") {
      const row = {
        requestId: params.requestId, url: params.request?.url ?? null, method: params.request?.method ?? null,
        resourceType: params.type ?? null, documentURL: params.documentURL ?? null,
        assetKind: assetKind(params.request?.url), startedAt: params.timestamp ?? null,
        redirectStatus: params.redirectResponse?.status ?? null, status: "pending"
      };
      this.requests.set(params.requestId, row); this.record("network-request", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, ...row });
    } else if (method === "responseReceived") {
      const row = this.requests.get(params.requestId) ?? { requestId: params.requestId, url: params.response?.url ?? null, assetKind: assetKind(params.response?.url) };
      Object.assign(row, {
        status: "response", responseStatus: params.response?.status ?? null, statusText: params.response?.statusText ?? null,
        mimeType: params.response?.mimeType ?? null, fromDiskCache: params.response?.fromDiskCache ?? null,
        fromServiceWorker: params.response?.fromServiceWorker ?? null, responseAt: params.timestamp ?? null
      });
      this.requests.set(params.requestId, row); this.record("network-response", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, ...row });
    } else if (method === "loadingFinished") {
      const row = this.requests.get(params.requestId) ?? { requestId: params.requestId, url: null, assetKind: null };
      Object.assign(row, { status: "finished", finishedAt: params.timestamp ?? null, metrics: params.metrics ?? null });
      this.requests.set(params.requestId, row); this.record("network-finished", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, ...row });
    } else if (method === "loadingFailed") {
      const row = this.requests.get(params.requestId) ?? { requestId: params.requestId, url: null, assetKind: null };
      Object.assign(row, { status: "failed", failedAt: params.timestamp ?? null, errorText: params.errorText ?? null, canceled: params.canceled ?? false });
      this.requests.set(params.requestId, row); this.record("network-failed", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, ...row });
    } else if (method === "webSocketCreated") {
      const row = { requestId: params.requestId, url: params.url ?? null, status: "created" };
      this.webSockets.set(params.requestId, row); this.record("websocket", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, event: "created", ...row });
    } else if (method === "webSocketHandshakeResponseReceived") {
      const row = this.webSockets.get(params.requestId) ?? { requestId: params.requestId, url: null };
      Object.assign(row, { status: "open", responseStatus: params.response?.status ?? null });
      this.webSockets.set(params.requestId, row); this.record("websocket", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, event: "open", ...row });
    } else if (method === "webSocketClosed" || method === "webSocketFrameError") {
      const row = this.webSockets.get(params.requestId) ?? { requestId: params.requestId, url: null };
      Object.assign(row, { status: method === "webSocketClosed" ? "closed" : "error", error: params.errorMessage ?? null });
      this.webSockets.set(params.requestId, row); this.record("websocket", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, event: row.status, ...row });
    } else if (method === "webSocketFrameSent" || method === "webSocketFrameReceived") {
      const receipt = webSocketFrameReceipt(method === "webSocketFrameSent" ? "sent" : "received", params);
      this.frames.push(receipt); this.record("websocket-frame", { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, ...receipt });
    }
    return true;
  }

  summary() {
    const requests = [...this.requests.values()];
    return {
      schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, status: this.status, error: this.error, eventCount: this.eventCount,
      requests, assets: requests.filter(request => request.assetKind),
      failedRequests: requests.filter(request => request.status === "failed" || (Number.isFinite(request.responseStatus) && request.responseStatus >= 400)),
      webSockets: [...this.webSockets.values()], frames: this.frames,
      sentFrameCount: this.frames.filter(frame => frame.direction === "sent").length,
      receivedFrameCount: this.frames.filter(frame => frame.direction === "received").length
    };
  }
}
