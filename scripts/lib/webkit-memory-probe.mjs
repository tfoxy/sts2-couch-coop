// Raw WebKit Inspector transport for local attribution experiments.  This is deliberately
// independent of Playwright's browser API: WebKit's Memory domain is not exposed there.
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";

export const WEBKIT_MEMORY_SCHEMA = "couchcoop-webkit-memory/2";

export class NulJsonFramer {
  #tail = Buffer.alloc(0);

  push(chunk) {
    const input = Buffer.concat([this.#tail, Buffer.from(chunk)]);
    const messages = [];
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] !== 0) continue;
      if (i > start) messages.push(JSON.parse(input.subarray(start, i).toString("utf8")));
      start = i + 1;
    }
    this.#tail = input.subarray(start);
    return messages;
  }

  finish() {
    if (this.#tail.length) throw new Error("WebKit inspector closed with an unterminated JSON frame");
  }
}

export class ProtocolTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "ProtocolTimeoutError";
  }
}

/** A protocol-declared command failure, retaining the fields capability probes need. */
export class ProtocolCommandError extends Error {
  constructor(error, { method = null, scope = null } = {}) {
    super(error?.message ?? JSON.stringify(error));
    this.name = "ProtocolCommandError";
    this.code = error?.code ?? null;
    this.data = error?.data ?? null;
    this.method = method;
    this.scope = scope;
  }
}

const withTimeout = (promise, label, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new ProtocolTimeoutError(label, timeoutMs)), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** A NUL-delimited Inspector connection with separate outer/page-proxy/target request ids. */
export class WebKitInspector extends EventEmitter {
  #stdin;
  #nextId = 0;
  #outer = new Map();
  #proxy = new Map();
  #target = new Map();
  #framer = new NulJsonFramer();
  #closed = false;
  #expectedClose = false;
  pageProxyId = null;
  targetId = null;
  boundTargetId = null;
  contextId = null;
  mainFrameId = null;
  errors = [];

  constructor({ stdin, stdout, stderr, onClose }) {
    super();
    this.#stdin = stdin;
    stdout.on("data", chunk => {
      try { for (const message of this.#framer.push(chunk)) this.#receive(message); }
      catch (error) { this.#fatal(error); }
    });
    stderr?.on("data", chunk => this.emit("stderr", chunk.toString("utf8")));
    stdout.on("end", () => {
      try { this.#framer.finish(); } catch (error) { this.#fatal(error); return; }
      this.#fatal(new Error("WebKit inspector pipe closed"));
    });
    onClose?.(() => this.#fatal(new Error("WebKit process exited")));
  }

  get closed() { return this.#closed; }

  async bootstrap({ width = 844, height = 390, deviceScaleFactor = 3, timeoutMs = 10_000 } = {}) {
    await this.outer("Playwright.enable", {}, timeoutMs);
    const context = await this.outer("Playwright.createContext", {}, timeoutMs);
    this.contextId = context.browserContextId;
    const page = await this.outer("Playwright.createPage", { browserContextId: this.contextId }, timeoutMs);
    this.pageProxyId = page.pageProxyId;
    if (!this.targetId) await this.waitFor("target", timeoutMs);
    await this.proxy("Target.resume", { targetId: this.targetId }, timeoutMs);
    await this.proxy("Emulation.setDeviceMetricsOverride", {
      width, height, fixedLayout: true, deviceScaleFactor
    }, timeoutMs);
    await this.bindActiveTarget(timeoutMs);
    const tree = await this.targetCommand("Page.getResourceTree", {}, timeoutMs);
    this.mainFrameId = tree.frameTree?.frame?.id ?? null;
    if (!this.mainFrameId) throw new Error("WebKit did not report an initial main-frame id");
    return { contextId: this.contextId, pageProxyId: this.pageProxyId, targetId: this.targetId, mainFrameId: this.mainFrameId };
  }

  /** Re-enable target-local domains after a committed navigation target is selected. */
  async bindActiveTarget(timeoutMs = 10_000) {
    if (!this.targetId) await this.waitFor("target", timeoutMs);
    if (this.boundTargetId === this.targetId) return;
    await this.targetCommand("Page.enable", {}, timeoutMs);
    await this.targetCommand("Runtime.enable", {}, timeoutMs);
    this.boundTargetId = this.targetId;
  }

  outer(method, params = {}, timeoutMs = 10_000) {
    return this.#request(this.#outer, { method, params }, `outer ${method}`, timeoutMs);
  }

  proxy(method, params = {}, timeoutMs = 10_000) {
    if (!this.pageProxyId) throw new Error(`cannot send ${method}: no page proxy`);
    return this.#request(this.#proxy, { method, params, pageProxyId: this.pageProxyId }, `proxy ${method}`, timeoutMs);
  }

  targetCommand(method, params = {}, timeoutMs = 10_000) {
    if (!this.pageProxyId || !this.targetId) throw new Error(`cannot send ${method}: no non-provisional target`);
    const innerId = ++this.#nextId;
    const inner = { id: innerId, method, params };
    const targetId = this.targetId;
    const promise = withTimeout(new Promise((resolve, reject) => this.#target.set(innerId, {
      resolve, reject, targetId, method, scope: "target"
    })), `target ${method}`, timeoutMs);
    this.proxy("Target.sendMessageToTarget", { targetId, message: JSON.stringify(inner) }, timeoutMs)
      .catch(error => this.#settle(this.#target, innerId, error));
    return promise;
  }

  async navigate(url, timeoutMs = 10_000) {
    const result = await this.outer("Playwright.navigate", { url, pageProxyId: this.pageProxyId, frameId: this.mainFrameId }, timeoutMs);
    // Cross-document navigation may replace the target asynchronously. targetCreated updates
    // targetId immediately; a destroyed target makes later commands fail closed rather than
    // silently sending a Memory command to a retired page.
    await this.bindActiveTarget(timeoutMs);
    return result;
  }

  waitFor(event, timeoutMs = 10_000) {
    return withTimeout(new Promise(resolve => this.once(event, resolve)), event, timeoutMs);
  }

  async close(timeoutMs = 2_000) {
    if (this.#closed) return;
    // WebKit may close the pipe before acknowledging Playwright.close. Once teardown was explicitly
    // requested, that close is expected; failures before this method remain diagnostic errors.
    this.#expectedClose = true;
    try {
      await this.outer("Playwright.close", {}, timeoutMs);
    } catch { /* browser can close before replying */ }
    this.#stdin.end();
  }

  #request(map, payload, label, timeoutMs) {
    if (this.#closed) return Promise.reject(new Error(`cannot send ${label}: inspector is closed`));
    const id = ++this.#nextId;
    const message = { id, ...payload };
    const scope = label.split(" ", 1)[0] ?? null;
    const promise = withTimeout(new Promise((resolve, reject) => map.set(id, {
      resolve, reject, method: payload.method, scope
    })), label, timeoutMs);
    if (process.env.WEBKIT_MEMORY_DEBUG) process.stderr.write(`[webkit-inspector->] ${JSON.stringify(message)}\n`);
    this.#stdin.write(`${JSON.stringify(message)}\0`);
    return promise;
  }

  #receive(message) {
    if (process.env.WEBKIT_MEMORY_DEBUG) process.stderr.write(`[webkit-inspector] ${JSON.stringify(message)}\n`);
    if (message.pageProxyId && message.method === "Target.dispatchMessageFromTarget") {
      const nested = JSON.parse(message.params.message);
      this.#receiveTarget(nested, message.params.targetId);
      return;
    }
    if (message.pageProxyId && message.id) { this.#settle(this.#proxy, message.id, message); return; }
    if (message.id) { this.#settle(this.#outer, message.id, message); return; }
    if (message.method === "Target.targetCreated") {
      const info = message.params?.targetInfo;
      if (info?.type === "page" && !info.isProvisional) {
        this.targetId = info.targetId;
        this.emit("target", info);
      }
    }
    if (message.method === "Target.didCommitProvisionalTarget") {
      const oldTargetId = message.params?.oldTargetId;
      const newTargetId = message.params?.newTargetId;
      if (!newTargetId) { this.#fatal(new Error("provisional target commit omitted newTargetId")); return; }
      this.#rejectTargetCalls(oldTargetId, "provisional target committed");
      this.targetId = newTargetId;
      this.boundTargetId = null;
      this.emit("target", { targetId: newTargetId, committedFrom: oldTargetId });
      return;
    }
    if (message.method === "Target.targetDestroyed" && message.params?.targetId === this.targetId) {
      const destroyedId = this.targetId;
      this.targetId = null;
      if (this.boundTargetId === destroyedId) this.boundTargetId = null;
      // A target can be retired between provisional and committed navigation targets.  Commands
      // issued while null fail closed; a subsequent non-provisional target restores the session.
      this.#rejectTargetCalls(destroyedId, "active WebKit target was destroyed");
      this.emit("target-destroyed", message.params);
      return;
    }
    this.emit("event", message);
  }

  #receiveTarget(message, targetId) {
    if (message.id) {
      const waiter = this.#target.get(message.id);
      if (waiter && waiter.targetId !== targetId) this.#settle(this.#target, message.id, new Error("target response arrived from a replaced target"));
      else this.#settle(this.#target, message.id, message);
      return;
    }
    this.emit("target-event", { ...message, targetId });
  }

  #rejectTargetCalls(targetId, reason) {
    for (const [id, waiter] of this.#target) {
      if (waiter.targetId === targetId) this.#settle(this.#target, id, new Error(reason));
    }
  }

  #settle(map, id, messageOrError) {
    const waiter = map.get(id);
    if (!waiter) return;
    map.delete(id);
    if (messageOrError instanceof Error) waiter.reject(messageOrError);
    else if (messageOrError.error) waiter.reject(new ProtocolCommandError(messageOrError.error, waiter));
    else waiter.resolve(messageOrError.result ?? {});
  }

  #fatal(error) {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#expectedClose) this.errors.push(error.message);
    for (const map of [this.#outer, this.#proxy, this.#target]) {
      for (const { reject } of map.values()) reject(error);
      map.clear();
    }
    this.emit("fatal", error);
  }
}

function parentMap() {
  const result = new Map();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        result.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      } catch { /* process raced */ }
    }
  } catch { return null; }
  return result;
}

/** Linux-only total RSS for processes descended from the launched WebKit root. */
export function sampleWebKitTreeRss(rootPid) {
  const parents = parentMap();
  if (!parents) return null;
  const descends = pid => {
    for (let p = pid, hops = 0; p > 1 && hops < 64; hops++, p = parents.get(p) ?? 0) if (p === rootPid) return true;
    return false;
  };
  const processes = [];
  for (const pid of parents.keys()) {
    if (pid !== rootPid && !descends(pid)) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rssKb = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1]);
      if (Number.isFinite(rssKb)) processes.push({ pid, rssBytes: rssKb * 1024 });
    } catch { /* process raced */ }
  }
  if (!processes.some(p => p.pid === rootPid)) return null;
  return { rootPid, processes, totalBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0) };
}

export const maxMemoryCategories = samples => {
  const peak = {};
  for (const sample of samples) for (const [name, bytes] of Object.entries(sample.categories ?? {})) {
    if (typeof bytes === "number") peak[name] = Math.max(peak[name] ?? 0, bytes);
  }
  return peak;
};

export const summarizeMemoryWindow = (samples, start) => {
  const window = samples.slice(start);
  return {
    sampleRange: [start, samples.length], sampleCount: window.length,
    latestCategories: window.at(-1)?.categories ?? null, peakCategories: maxMemoryCategories(window)
  };
};

export const isMeasuredMemoryCapture = ({ inspectorClosed, lifecycle, samples }) =>
  !inspectorClosed && lifecycle?.started === true && lifecycle?.completed === true &&
  samples.filter(sample => Object.values(sample.categories ?? {}).some(value => Number(value) > 0)).length >= 2;
